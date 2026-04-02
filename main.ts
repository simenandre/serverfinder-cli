/**
 * Server Auction Filter for Dina
 *
 * Fetches and filters dedicated server auctions from Hetzner, Gigahost,
 * OVH Eco, and OneProvider, normalizing them into a common format and ranking by use-case:
 * compute, database, object-storage, cache, ai-inference, observability.
 */

import { fetchOneProvider } from "./oneprovider.ts";

const HETZNER_URL =
  "https://www.hetzner.com/_resources/app/data/app/live_data_sb_EUR.json";
const GIGAHOST_URL =
  "https://api.gigahost.no/api/v2/auction?api_key=weborder";
const OVH_CATALOG_URL =
  "https://eu.api.ovh.com/v1/order/catalog/public/eco?ovhSubsidiary=DE";
const OVH_AVAILABILITY_URL =
  "https://eu.api.ovh.com/v1/dedicated/server/datacenter/availabilities?excludeDatacenters=false";

// Approximate NOK → EUR rate (Gigahost prices are in NOK)
const NOK_TO_EUR = 0.085;

// Gigahost offers a 15% discount when paying annually
const GIGAHOST_ANNUAL_DISCOUNT = 0.15;

// ---------------------------------------------------------------------------
// Unified server type (provider-agnostic)
// ---------------------------------------------------------------------------

interface AuctionServer {
  id: number;
  provider: "hetzner" | "gigahost" | "ovh" | "oneprovider";
  cpu: string;
  cpu_count: number;
  ram_size: number; // GB
  is_ecc: boolean;
  price: number; // EUR/month (converted for Gigahost)
  priceOriginal: number; // original price in source currency
  currency: "EUR" | "NOK";
  hdd_size: number; // single disk GB
  hdd_count: number;
  hdd_arr: string[];
  serverDiskData: ServerDiskData;
  datacenter: string;
  bandwidth: number; // Mbit/s
  specials: string[];
  fixed_price: boolean;
  gpu_model: string | null; // e.g. "GeForce GTX 1080", "Nvidia RTX 6000 Ada"
  known_cores?: number; // pre-resolved core count (e.g. from OVH catalog)
  url: string; // direct link to server listing
}

interface ServerDiskData {
  nvme: number[];
  sata: number[];
  hdd: number[];
  general: number[];
}

// ---------------------------------------------------------------------------
// Hetzner types & ingestion
// ---------------------------------------------------------------------------

interface HetznerServer {
  id: number;
  cpu: string;
  cpu_count: number;
  ram_size: number;
  is_ecc: boolean;
  price: number;
  hdd_size: number;
  hdd_count: number;
  hdd_arr: string[];
  serverDiskData: ServerDiskData;
  datacenter: string;
  bandwidth: number;
  specials: string[];
  fixed_price: boolean;
  description: string[];
}

interface HetznerResponse {
  server: HetznerServer[];
}

/** Extract GPU model from Hetzner description array, e.g. "GPU - GeForce GTX 1080" → "GeForce GTX 1080" */
function parseHetznerGpu(description: string[]): string | null {
  const gpuLine = description.find((d) => d.startsWith("GPU - "));
  return gpuLine ? gpuLine.replace("GPU - ", "") : null;
}

function normalizeHetzner(s: HetznerServer): AuctionServer {
  return {
    id: s.id,
    provider: "hetzner",
    cpu: s.cpu,
    cpu_count: s.cpu_count,
    ram_size: s.ram_size,
    is_ecc: s.is_ecc,
    price: s.price,
    priceOriginal: s.price,
    currency: "EUR",
    hdd_size: s.hdd_size,
    hdd_count: s.hdd_count,
    hdd_arr: s.hdd_arr,
    serverDiskData: s.serverDiskData,
    datacenter: s.datacenter,
    bandwidth: s.bandwidth,
    specials: s.specials,
    fixed_price: s.fixed_price,
    gpu_model: parseHetznerGpu(s.description),
    url: `https://www.hetzner.com/sb?search=${s.id}`,
  };
}

// ---------------------------------------------------------------------------
// Gigahost types & ingestion
// ---------------------------------------------------------------------------

interface GigahostServer {
  auction_id: string;
  product_id: string;
  auction_price: string; // NOK
  auction_price_start: string;
  auction_reduction_time: string;
  auction_last_reduction: string;
  server_location: string;
  server_cpu: string;
  server_ram: string; // e.g. "128GB"
  server_storage: string; // e.g. "1TB NVMe + 18TB HDD"
  server_bandwidth: string;
  server_port: string;
  fixed_price: boolean;
}

/** Parse Gigahost free-text storage like "4 x 8TB HDD" or "250GB SSD + 12 x 12TB HDD" */
function parseGigahostStorage(text: string): ServerDiskData {
  const result: ServerDiskData = { nvme: [], sata: [], hdd: [], general: [] };

  // Split on " + " to handle mixed configs
  const parts = text.split(/\s*\+\s*/);

  for (const part of parts) {
    const trimmed = part.trim();
    // Match patterns like "4 x 8TB HDD", "500GB SSD", "1TB NVMe"
    const match = trimmed.match(
      /^(?:(\d+)\s*x\s*)?(\d+(?:\.\d+)?)\s*(TB|GB)\s+(NVMe|SSD|HDD)$/i,
    );
    if (!match) continue;

    const count = match[1] ? parseInt(match[1]) : 1;
    let sizeGB = parseFloat(match[2]);
    if (match[3].toUpperCase() === "TB") sizeGB *= 1000;
    const type = match[4].toUpperCase();

    const sizes = Array(count).fill(sizeGB);

    if (type === "NVME") {
      result.nvme.push(...sizes);
    } else if (type === "SSD") {
      // Gigahost doesn't distinguish SATA vs other SSD — treat as sata
      result.sata.push(...sizes);
    } else {
      result.hdd.push(...sizes);
    }
  }

  if (result.general.length === 0) {
    const first = [...result.nvme, ...result.sata, ...result.hdd][0];
    if (first) result.general.push(first);
  }

  return result;
}

/** Parse RAM string like "128GB" → number */
function parseGigahostRam(text: string): number {
  const match = text.match(/(\d+)\s*GB/i);
  return match ? parseInt(match[1]) : 0;
}

/** Strip clock speed from CPU string: "AMD Ryzen 9 3950X 3.6GHz" → "AMD Ryzen 9 3950X" */
function parseGigahostCpu(text: string): { cpu: string; count: number } {
  let count = 1;
  let cpuStr = text;

  // Handle "Dual Intel Xeon ..."
  if (cpuStr.startsWith("Dual ")) {
    count = 2;
    cpuStr = cpuStr.replace(/^Dual\s+/, "");
  }

  // Strip trailing clock speed
  cpuStr = cpuStr.replace(/\s+\d+(\.\d+)?GHz$/i, "").trim();

  return { cpu: cpuStr, count };
}

/** Parse bandwidth string like "1Gbit/s" → Mbit/s */
function parseGigahostBandwidth(text: string): number {
  const match = text.match(/(\d+)\s*Gbit/i);
  return match ? parseInt(match[1]) * 1000 : 1000;
}

function normalizeGigahost(s: GigahostServer): AuctionServer {
  const priceNOK = parseFloat(s.auction_price);
  const priceEUR = Math.round(priceNOK * NOK_TO_EUR * 100) / 100;
  const disk = parseGigahostStorage(s.server_storage);
  const { cpu, count: cpuCount } = parseGigahostCpu(s.server_cpu);
  const allDisks = [...disk.nvme, ...disk.sata, ...disk.hdd];

  return {
    id: parseInt(s.auction_id),
    provider: "gigahost",
    cpu,
    cpu_count: cpuCount,
    ram_size: parseGigahostRam(s.server_ram),
    is_ecc: cpu.includes("Xeon") || cpu.includes("EPYC"), // infer from CPU
    price: priceEUR,
    priceOriginal: priceNOK,
    currency: "NOK",
    hdd_size: allDisks[0] ?? 0,
    hdd_count: allDisks.length,
    hdd_arr: s.server_storage.split(/\s*\+\s*/),
    serverDiskData: disk,
    datacenter: s.server_location,
    bandwidth: parseGigahostBandwidth(s.server_bandwidth),
    specials: s.server_port.includes("10G") ? ["10G"] : [],
    fixed_price: s.fixed_price,
    gpu_model: null,
    url: `https://www.gigahost.no/server/auksjon/${s.auction_id}`,
  };
}

// ---------------------------------------------------------------------------
// OVH Eco types & ingestion
// ---------------------------------------------------------------------------

interface OvhCatalog {
  locale: { currencyCode: string };
  plans: OvhPlan[];
  products: OvhProduct[];
  addons: OvhAddon[];
}

interface OvhPlan {
  planCode: string;
  invoiceName: string;
  product: string;
  pricings: OvhPricing[];
  addonFamilies: { name: string; addons: string[] }[];
}

interface OvhPricing {
  capacities: string[];
  intervalUnit: string;
  interval: number;
  price: number;
  mode: string;
}

interface OvhProduct {
  name: string;
  blobs?: {
    technical?: {
      server?: {
        cpu?: {
          brand: string;
          model: string;
          cores: number;
          threads: number;
          frequency: number;
        };
      };
      memory?: { ecc: boolean; size: number; ramType: string };
      storage?: {
        disks: {
          number: number;
          capacity: number;
          interface: string;
          technology: string;
        }[];
      };
    };
  };
}

interface OvhAddon {
  planCode: string;
  product: string;
  invoiceName: string;
  pricings: OvhPricing[];
}

interface OvhAvailability {
  fqn: string;
  planCode: string;
  memory: string;
  storage: string;
  server: string;
  datacenters: { availability: string; datacenter: string }[];
}

const OVH_EU_DATACENTERS = new Set([
  "fra", "gra", "rbx", "sbg", "waw", "lon",
]);

function resolveOvhProduct(
  catalog: OvhCatalog,
  productName: string,
): OvhProduct | undefined {
  return catalog.products.find((p) => p.name === productName);
}

function resolveOvhAddon(
  catalog: OvhCatalog,
  addonCode: string,
): { addon: OvhAddon; product: OvhProduct | undefined } | undefined {
  const addon = catalog.addons.find((a) => a.planCode === addonCode);
  if (!addon) return undefined;
  const product = resolveOvhProduct(catalog, addon.product);
  return { addon, product };
}

function getOvhMonthlyPrice(pricings: OvhPricing[]): number {
  const renew = pricings.find(
    (p) =>
      p.capacities.includes("renew") &&
      p.intervalUnit === "month" &&
      p.interval === 1 &&
      p.mode === "default",
  );
  // Price is in millicents (10^-7 of currency unit)
  return renew ? renew.price / 10_000_000 : 0;
}

function ovhStorageToServerDiskData(
  disks: { number: number; capacity: number; interface: string; technology: string }[],
): ServerDiskData {
  const result: ServerDiskData = { nvme: [], sata: [], hdd: [], general: [] };
  for (const d of disks) {
    const sizes = Array(d.number).fill(d.capacity);
    const tech = d.technology.toUpperCase();
    const iface = d.interface.toUpperCase();

    if (iface === "NVME" || tech === "NVME") {
      result.nvme.push(...sizes);
    } else if (tech === "SSD" || tech === "SATA") {
      result.sata.push(...sizes);
    } else {
      result.hdd.push(...sizes);
    }
  }
  return result;
}

function normalizeOvh(
  plan: OvhPlan,
  catalog: OvhCatalog,
  availableDCs: string[],
): AuctionServer | null {
  const product = resolveOvhProduct(catalog, plan.product);
  const cpu = product?.blobs?.technical?.server?.cpu;
  if (!cpu) return null;

  const price = getOvhMonthlyPrice(plan.pricings);
  if (price <= 0) return null;

  // Resolve default memory and storage from addon families
  let ramSize = 0;
  let isEcc = false;
  let diskData: ServerDiskData = { nvme: [], sata: [], hdd: [], general: [] };

  for (const family of plan.addonFamilies) {
    const firstAddon = family.addons[0];
    if (!firstAddon) continue;

    const resolved = resolveOvhAddon(catalog, firstAddon);
    if (!resolved?.product?.blobs?.technical) continue;

    const tech = resolved.product.blobs.technical;
    if (family.name === "memory" && tech.memory) {
      ramSize = tech.memory.size;
      isEcc = tech.memory.ecc;
    }
    if (family.name === "storage" && tech.storage) {
      diskData = ovhStorageToServerDiskData(tech.storage.disks);
    }
  }

  const allDisks = [...diskData.nvme, ...diskData.sata, ...diskData.hdd];
  const cpuName = `${cpu.brand} ${cpu.model}`;

  return {
    id: hashPlanCode(plan.planCode),
    provider: "ovh",
    cpu: cpuName,
    cpu_count: 1,
    ram_size: ramSize,
    is_ecc: isEcc,
    price: Math.round(price * 100) / 100,
    priceOriginal: Math.round(price * 100) / 100,
    currency: "EUR",
    hdd_size: allDisks[0] ?? 0,
    hdd_count: allDisks.length,
    hdd_arr: allDisks.map((s) => `${s} GB`),
    serverDiskData: diskData,
    datacenter: availableDCs.join(","),
    bandwidth: 1000,
    specials: [],
    fixed_price: true,
    gpu_model: null,
    known_cores: cpu.cores,
    url: `https://eco.ovhcloud.com/en/kimsufi/${plan.planCode}/`,
  };
}

/** Stable numeric ID from planCode string */
function hashPlanCode(code: string): number {
  let h = 0;
  for (let i = 0; i < code.length; i++) {
    h = ((h << 5) - h + code.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// ---------------------------------------------------------------------------
// Derived metrics
// ---------------------------------------------------------------------------

interface ServerMetrics {
  server: AuctionServer;
  totalStorageGB: number;
  storageType: "nvme" | "sata" | "hdd" | "mixed";
  nvmeGB: number;
  sataGB: number;
  hddGB: number;
  cpuCores: number;
  pricePerTB: number;
  pricePerGBRam: number;
  pricePerCore: number;
  location: string;
  hasGPU: boolean;
  gpuModel: string | null;
  hasECC: boolean;
}

function extractCpuCores(cpu: string): number {
  const coreMap: Record<string, number> = {
    "Intel Core i5-4570S": 4,
    "Intel Core i7-2600": 4,
    "Intel Core i7-3770": 4,
    "Intel Core i7-4770": 4,
    "Intel Core i7-6700": 4,
    "Intel Core i7-7700": 4,
    "Intel Core i7-8700": 6,
    "Intel Core i9-9900K": 8,
    "Intel Core i9-12900K": 16,
    "Intel Xeon E3-1245": 4,
    "Intel Xeon E3-1245V2": 4,
    "Intel Xeon E3-1246V3": 4,
    "Intel Xeon E3-1270V3": 4,
    "Intel Xeon E3-1271V3": 4,
    "Intel Xeon E3-1275V5": 4,
    "Intel Xeon E5-1620V2": 4,
    "Intel Xeon E5-1650V2": 6,
    "Intel Xeon E5-1650V3": 6,
    "Intel Xeon E5-2620V3": 6,
    "Intel Xeon E5-2630V4": 10,
    "Intel Xeon E5-2630L V3": 8,
    "Intel Xeon E5-2650Lv2": 10,
    "Intel Xeon E5-1680V4": 8,
    "Intel Xeon W-2145": 8,
    "Intel Xeon W-2245": 8,
    "Intel Xeon W-2295": 18,
    "AMD Ryzen 5 3600": 6,
    "AMD Ryzen 7 3700X": 8,
    "AMD Ryzen 7 5800X": 8,
    "AMD Ryzen 9 3900": 12,
    "AMD Ryzen 9 3950X": 16,
    "AMD Ryzen 9 5900X": 12,
    "AMD Ryzen 9 5900XT": 12,
    "AMD Ryzen 9 5950X": 16,
    "AMD Ryzen 9 7900": 12,
    "AMD Ryzen 9 7950X3D": 16,
    "AMD EPYC 7401P": 24,
    "AMD EPYC 7502P": 32,
    "AMD EPYC 7443P": 24,
    "AMD EPYC 9454P": 48,
    "Intel Xeon Gold 5412U": 24,
  };
  return coreMap[cpu] ?? estimateCores(cpu);
}

function estimateCores(cpu: string): number {
  if (cpu.includes("EPYC")) return 24;
  if (cpu.includes("i9") || cpu.includes("5950") || cpu.includes("7950"))
    return 16;
  if (cpu.includes("Ryzen 9")) return 12;
  if (cpu.includes("Ryzen 7")) return 8;
  if (cpu.includes("Ryzen 5")) return 6;
  if (cpu.includes("i7-8") || cpu.includes("i7-9")) return 6;
  if (cpu.includes("i7")) return 4;
  if (cpu.includes("i5")) return 4;
  if (cpu.includes("Xeon E5-26")) return 8;
  if (cpu.includes("Xeon E5")) return 6;
  if (cpu.includes("Xeon E3")) return 4;
  if (cpu.includes("Xeon W")) return 8;
  return 4;
}

function deriveMetrics(server: AuctionServer): ServerMetrics {
  const disk = server.serverDiskData;
  const nvmeGB = disk.nvme.reduce((a, b) => a + b, 0);
  const sataGB = disk.sata.reduce((a, b) => a + b, 0);
  const hddGB = disk.hdd.reduce((a, b) => a + b, 0);
  const totalStorageGB = nvmeGB + sataGB + hddGB;

  const types = [
    nvmeGB > 0 && "nvme",
    sataGB > 0 && "sata",
    hddGB > 0 && "hdd",
  ].filter(Boolean) as string[];

  const storageType: ServerMetrics["storageType"] =
    types.length > 1
      ? "mixed"
      : (types[0] as "nvme" | "sata" | "hdd") ?? "sata";

  const cpuCores = server.known_cores ?? extractCpuCores(server.cpu) * server.cpu_count;

  const location =
    server.provider === "hetzner"
      ? server.datacenter.replace(/-.*/, "").replace(/\d+$/, "")
      : server.provider === "ovh"
        ? parseOvhLocation(server.datacenter)
        : server.provider === "oneprovider"
          ? parseOneProviderLocation(server.datacenter)
          : parseGigahostLocation(server.datacenter);

  return {
    server,
    totalStorageGB,
    storageType,
    nvmeGB,
    sataGB,
    hddGB,
    cpuCores,
    pricePerTB:
      totalStorageGB > 0
        ? server.price / (totalStorageGB / 1000)
        : Infinity,
    pricePerGBRam:
      server.ram_size > 0 ? server.price / server.ram_size : Infinity,
    pricePerCore: cpuCores > 0 ? server.price / cpuCores : Infinity,
    location,
    hasGPU: server.specials.includes("GPU"),
    gpuModel: server.gpu_model,
    hasECC: server.is_ecc,
  };
}

/** Extract short location from Gigahost datacenter string like "SFJ, NO (NO DC1)" → "SFJ" */
function parseGigahostLocation(dc: string): string {
  const match = dc.match(/^([A-Z]{2,4})/);
  return match ? match[1] : dc;
}

/** Extract short location from OneProvider datacenter string like "Amsterdam, NL" → "AMS" */
function parseOneProviderLocation(dc: string): string {
  const map: Record<string, string> = {
    Amsterdam: "AMS", Paris: "PAR", Frankfurt: "FRA", Warsaw: "WAW",
    London: "LON", Brussels: "BRU", Zurich: "ZUR", Milan: "MIL",
    Madrid: "MAD", Bucharest: "BUC", Sofia: "SOF", Stockholm: "STO",
    Oslo: "OSL", Helsinki: "HEL", Copenhagen: "CPH", Vienna: "VIE",
    Dublin: "DUB", Lisbon: "LIS", Prague: "PRG",
  };
  const city = dc.split(",")[0].trim();
  return map[city] ?? city.slice(0, 3).toUpperCase();
}

/** Map OVH datacenter codes to readable locations */
function parseOvhLocation(dc: string): string {
  const map: Record<string, string> = {
    fra: "FRA",
    gra: "GRA",
    rbx: "RBX",
    sbg: "SBG",
    waw: "WAW",
    lon: "LON",
  };
  const first = dc.split(",")[0].trim();
  return map[first] ?? first.toUpperCase();
}

// ---------------------------------------------------------------------------
// Use-case filters
// ---------------------------------------------------------------------------

type UseCase =
  | "compute"
  | "database"
  | "object-storage"
  | "cache"
  | "ai-inference"
  | "observability"
  | "simulation-testing";

interface FilterConfig {
  label: string;
  description: string;
  filter: (m: ServerMetrics) => boolean;
  sort: (a: ServerMetrics, b: ServerMetrics) => number;
  columns: (m: ServerMetrics) => Record<string, string | number>;
}

const useCases: Record<UseCase, FilterConfig> = {
  compute: {
    label: "Compute (Containers / Kubernetes)",
    description:
      "Multi-core CPUs, 32+ GB RAM, NVMe preferred. Ranked by price/core.",
    filter: (m) =>
      m.cpuCores >= 6 &&
      m.server.ram_size >= 32 &&
      m.totalStorageGB >= 240,
    sort: (a, b) => a.pricePerCore - b.pricePerCore,
    columns: (m) => ({
      "€/core": m.pricePerCore.toFixed(2),
      cores: m.cpuCores,
      "RAM GB": m.server.ram_size,
      storage: `${m.totalStorageGB} GB ${m.storageType}`,
      "€/mo": m.server.price,
    }),
  },

  database: {
    label: "Database (SQL / PostgreSQL)",
    description:
      "ECC RAM, 64+ GB RAM, fast NVMe/SATA SSD. Ranked by price/GB RAM.",
    filter: (m) =>
      m.hasECC &&
      m.server.ram_size >= 64 &&
      (m.nvmeGB > 0 || m.sataGB > 0) &&
      m.totalStorageGB >= 480,
    sort: (a, b) => a.pricePerGBRam - b.pricePerGBRam,
    columns: (m) => ({
      "€/GB RAM": m.pricePerGBRam.toFixed(2),
      "RAM GB": m.server.ram_size,
      ECC: m.hasECC ? "yes" : "no",
      storage: `${m.totalStorageGB} GB ${m.storageType}`,
      cores: m.cpuCores,
      "€/mo": m.server.price,
    }),
  },

  "object-storage": {
    label: "Object Storage (S3-compatible / MinIO)",
    description: "Maximum raw HDD capacity. Ranked by price/TB.",
    filter: (m) => m.hddGB >= 4000,
    sort: (a, b) => a.pricePerTB - b.pricePerTB,
    columns: (m) => ({
      "€/TB": m.pricePerTB.toFixed(2),
      "total TB": (m.totalStorageGB / 1000).toFixed(1),
      disks: `${m.server.hdd_count}x ${m.server.hdd_size} GB`,
      "RAM GB": m.server.ram_size,
      "€/mo": m.server.price,
    }),
  },

  cache: {
    label: "Cache / Key-Value (Redis / Valkey)",
    description: "Maximum RAM, fast storage. Ranked by price/GB RAM.",
    filter: (m) =>
      m.server.ram_size >= 64 && (m.nvmeGB > 0 || m.sataGB > 0),
    sort: (a, b) => a.pricePerGBRam - b.pricePerGBRam,
    columns: (m) => ({
      "€/GB RAM": m.pricePerGBRam.toFixed(2),
      "RAM GB": m.server.ram_size,
      storage: `${m.totalStorageGB} GB ${m.storageType}`,
      cores: m.cpuCores,
      "€/mo": m.server.price,
    }),
  },

  "ai-inference": {
    label: "AI Inference (LLM Hosting)",
    description:
      "Maximum RAM (128+ GB) for CPU inference, many cores, GPU if available. Ranked by RAM then price.",
    filter: (m) =>
      (m.server.ram_size >= 128 && m.cpuCores >= 8) || m.hasGPU,
    sort: (a, b) => {
      if (a.hasGPU !== b.hasGPU) return a.hasGPU ? -1 : 1;
      if (a.server.ram_size !== b.server.ram_size)
        return b.server.ram_size - a.server.ram_size;
      return a.server.price - b.server.price;
    },
    columns: (m) => ({
      "RAM GB": m.server.ram_size,
      cores: m.cpuCores,
      GPU: m.gpuModel ?? "-",
      storage: `${m.totalStorageGB} GB ${m.storageType}`,
      "€/GB RAM": m.pricePerGBRam.toFixed(2),
      "€/mo": m.server.price,
    }),
  },

  "simulation-testing": {
    label: "Simulation Testing / Fuzzing",
    description:
      "Maximum cores for parallel fuzzing, 32+ GB RAM, fast NVMe for corpus I/O. Ranked by price/core then cores.",
    filter: (m) =>
      m.cpuCores >= 8 &&
      m.server.ram_size >= 32 &&
      m.nvmeGB >= 240,
    sort: (a, b) => {
      const priceDiff = a.pricePerCore - b.pricePerCore;
      if (Math.abs(priceDiff) > 0.5) return priceDiff;
      return b.cpuCores - a.cpuCores;
    },
    columns: (m) => ({
      "€/core": m.pricePerCore.toFixed(2),
      cores: m.cpuCores,
      "RAM GB": m.server.ram_size,
      "NVMe GB": m.nvmeGB,
      storage: `${m.totalStorageGB} GB ${m.storageType}`,
      "€/mo": m.server.price,
    }),
  },

  observability: {
    label: "Observability (Logs / Metrics / Tracing)",
    description:
      "Balanced RAM (64+ GB) and large SSD storage for time-series data. Ranked by price/TB SSD.",
    filter: (m) =>
      m.server.ram_size >= 64 && m.nvmeGB + m.sataGB >= 960,
    sort: (a, b) => {
      const aSsdTB = (a.nvmeGB + a.sataGB) / 1000;
      const bSsdTB = (b.nvmeGB + b.sataGB) / 1000;
      return a.server.price / aSsdTB - b.server.price / bSsdTB;
    },
    columns: (m) => ({
      "€/TB SSD": (
        (m.nvmeGB + m.sataGB) / 1000 > 0
          ? m.server.price / ((m.nvmeGB + m.sataGB) / 1000)
          : Infinity
      ).toFixed(2),
      "SSD GB": m.nvmeGB + m.sataGB,
      type: m.storageType,
      "RAM GB": m.server.ram_size,
      cores: m.cpuCores,
      "€/mo": m.server.price,
    }),
  },
};

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function providerTag(s: AuctionServer): string {
  if (s.provider === "hetzner") return "HZ";
  if (s.provider === "ovh") return "OVH";
  if (s.provider === "oneprovider") return "OP";
  return "GH";
}

function priceDisplay(m: ServerMetrics): string {
  if (m.server.provider === "gigahost") {
    return `€${m.server.price} (${m.server.priceOriginal} NOK)`;
  }
  return `€${m.server.price}`;
}



function printTable(
  headers: string[],
  rows: (string | number)[][],
) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length))
  );

  const sep = widths.map((w) => "─".repeat(w + 2)).join("┼");
  const fmt = (row: (string | number)[]) =>
    row.map((v, i) => ` ${String(v).padStart(widths[i])} `).join("│");

  console.log(fmt(headers));
  console.log(sep);
  rows.forEach((r) => console.log(fmt(r)));
}

function displayResults(
  useCase: UseCase,
  metrics: ServerMetrics[],
  limit: number,
  locationFilter?: string,
  providerFilter?: string,
) {
  const config = useCases[useCase];

  let filtered = metrics.filter(config.filter);
  if (locationFilter) {
    filtered = filtered.filter(
      (m) => m.location.toUpperCase() === locationFilter.toUpperCase(),
    );
  }
  if (providerFilter) {
    filtered = filtered.filter(
      (m) => m.server.provider === providerFilter,
    );
  }

  filtered.sort(config.sort);
  const top = filtered.slice(0, limit);

  console.log(`\n${"=".repeat(80)}`);
  console.log(`  ${config.label}`);
  console.log(`  ${config.description}`);
  console.log(`${"=".repeat(80)}`);
  console.log(
    `  ${filtered.length} servers matched (showing top ${top.length})\n`,
  );

  if (top.length === 0) {
    console.log("  No servers match these criteria.\n");
    return;
  }

  const sampleCols = config.columns(top[0]);
  const headers = [
    "#",
    "src",
    "ID",
    "CPU",
    "DC",
    ...Object.keys(sampleCols),
  ];
  const rows = top.map((m, i) => {
    const cols = config.columns(m);
    return [
      i + 1,
      providerTag(m.server),
      m.server.id,
      m.server.cpu,
      m.server.datacenter,
      ...Object.values(cols),
    ];
  });

  printTable(headers, rows);
  console.log();
  for (const m of top) {
    console.log(`  [${providerTag(m.server)} #${m.server.id}] ${m.server.url}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Summary view
// ---------------------------------------------------------------------------

function displaySummary(metrics: ServerMetrics[]) {
  console.log(`\n${"=".repeat(80)}`);
  console.log("  Market Summary");
  console.log(`${"=".repeat(80)}\n`);

  const byProvider: Record<string, ServerMetrics[]> = {};
  for (const m of metrics) {
    const p = m.server.provider;
    (byProvider[p] ??= []).push(m);
  }

  console.log(`  Total servers: ${metrics.length}`);
  for (const [p, list] of Object.entries(byProvider)) {
    console.log(`    ${p}: ${list.length}`);
  }

  const prices = metrics.map((m) => m.server.price);
  const rams = metrics.map((m) => m.server.ram_size);
  console.log(
    `  Price range:   €${Math.min(...prices).toFixed(0)} – €${Math.max(...prices).toFixed(0)}/mo (all converted to EUR)`,
  );
  console.log(
    `  RAM range:     ${Math.min(...rams)} – ${Math.max(...rams)} GB`,
  );

  const byStorage: Record<string, number> = {};
  for (const m of metrics) {
    byStorage[m.storageType] = (byStorage[m.storageType] ?? 0) + 1;
  }
  console.log(
    `  Storage types: ${Object.entries(byStorage)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ")}`,
  );

  const eccCount = metrics.filter((m) => m.hasECC).length;
  console.log(
    `  ECC servers:   ${eccCount} (${((eccCount / metrics.length) * 100).toFixed(0)}%)`,
  );

  const gpuCount = metrics.filter((m) => m.hasGPU).length;
  console.log(`  GPU servers:   ${gpuCount}`);

  const byLocation: Record<string, number> = {};
  for (const m of metrics) {
    byLocation[m.location] = (byLocation[m.location] ?? 0) + 1;
  }
  console.log(
    `  Locations:     ${Object.entries(byLocation)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ")}`,
  );

  console.log(`\n  NOK → EUR rate: ${NOK_TO_EUR} (used for Gigahost prices)`);

  console.log(`\n  Best deals per use-case:`);
  for (const [_key, config] of Object.entries(useCases)) {
    const matched = metrics.filter(config.filter);
    matched.sort(config.sort);
    const best = matched[0];
    if (best) {
      const tag = providerTag(best.server);
      console.log(
        `    ${config.label.padEnd(42)} → ${priceDisplay(best)}/mo  [${tag}] (${best.server.cpu}, ${best.server.ram_size}GB RAM, ${best.totalStorageGB}GB ${best.storageType})`,
      );
    } else {
      console.log(
        `    ${config.label.padEnd(42)} → no matches`,
      );
    }
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchHetzner(): Promise<AuctionServer[]> {
  const resp = await fetch(HETZNER_URL);
  if (!resp.ok) {
    console.error(
      `Failed to fetch Hetzner data: ${resp.status} ${resp.statusText}`,
    );
    return [];
  }
  const data: HetznerResponse = await resp.json();
  return data.server.map(normalizeHetzner);
}

async function fetchGigahost(): Promise<AuctionServer[]> {
  const resp = await fetch(GIGAHOST_URL);
  if (!resp.ok) {
    console.error(
      `Failed to fetch Gigahost data: ${resp.status} ${resp.statusText}`,
    );
    return [];
  }
  const data: GigahostServer[] = await resp.json();
  return data.map(normalizeGigahost);
}

async function fetchOvh(): Promise<AuctionServer[]> {
  const [catalogResp, availResp] = await Promise.all([
    fetch(OVH_CATALOG_URL),
    fetch(OVH_AVAILABILITY_URL),
  ]);

  if (!catalogResp.ok) {
    console.error(
      `Failed to fetch OVH catalog: ${catalogResp.status} ${catalogResp.statusText}`,
    );
    return [];
  }
  if (!availResp.ok) {
    console.error(
      `Failed to fetch OVH availability: ${availResp.status} ${availResp.statusText}`,
    );
    return [];
  }

  const catalog: OvhCatalog = await catalogResp.json();
  const availability: OvhAvailability[] = await availResp.json();

  // Build a map of planCode → available EU datacenters
  const availableMap = new Map<string, string[]>();
  for (const entry of availability) {
    const euDCs = entry.datacenters
      .filter(
        (dc) =>
          OVH_EU_DATACENTERS.has(dc.datacenter) &&
          dc.availability !== "unavailable" &&
          dc.availability !== "comingSoon",
      )
      .map((dc) => dc.datacenter);

    if (euDCs.length > 0) {
      const existing = availableMap.get(entry.planCode) ?? [];
      for (const dc of euDCs) {
        if (!existing.includes(dc)) existing.push(dc);
      }
      availableMap.set(entry.planCode, existing);
    }
  }

  const servers: AuctionServer[] = [];
  for (const plan of catalog.plans) {
    const dcs = availableMap.get(plan.planCode);
    if (!dcs || dcs.length === 0) continue;

    const server = normalizeOvh(plan, catalog, dcs);
    if (server && server.ram_size > 0) {
      servers.push(server);
    }
  }

  return servers;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`
Usage: deno run --allow-net main.ts [options]

Options:
  --use-case <name>    Filter for a specific use case (default: all)
                       Values: ${Object.keys(useCases).join(", ")}
  --limit <n>          Number of results per category (default: 15)
  --location <loc>     Filter by location: FSN, NBG, HEL, SFJ, AMS, ...
  --provider <name>    Filter by provider: hetzner, gigahost, ovh, oneprovider
  --max-price <eur>    Maximum monthly price in EUR
  --min-ram <gb>       Minimum RAM in GB
  --min-storage <gb>   Minimum total storage in GB
  --ecc-only           Only show ECC RAM servers
  --nvme-only          Only show NVMe storage servers
  --summary            Show market summary only
  --json               Output results as JSON
  --llm                Output a prompt + data for piping to an LLM (e.g. claude)
  --help               Show this help

Examples:
  deno run --allow-net main.ts
  deno run --allow-net main.ts --use-case object-storage --limit 20
  deno run --allow-net main.ts --use-case database --location FSN --ecc-only
  deno run --allow-net main.ts --use-case ai-inference --min-ram 256
  deno run --allow-net main.ts --provider gigahost --summary
  deno run --allow-net main.ts --max-price 100 --summary
  deno run --allow-net main.ts --use-case compute --llm | claude
`);
}

interface ParsedArgs {
  useCase?: UseCase;
  limit: number;
  location?: string;
  provider?: string;
  maxPrice?: number;
  minRam?: number;
  minStorage?: number;
  eccOnly: boolean;
  nvmeOnly: boolean;
  summary: boolean;
  json: boolean;
  llm: boolean;
  help: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    limit: 15,
    eccOnly: false,
    nvmeOnly: false,
    summary: false,
    json: false,
    llm: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--use-case":
        result.useCase = args[++i] as UseCase;
        if (!(result.useCase in useCases)) {
          console.error(
            `Unknown use case: ${result.useCase}. Valid: ${Object.keys(useCases).join(", ")}`,
          );
          Deno.exit(1);
        }
        break;
      case "--limit":
        result.limit = parseInt(args[++i]);
        break;
      case "--location":
        result.location = args[++i];
        break;
      case "--provider":
        result.provider = args[++i];
        break;
      case "--max-price":
        result.maxPrice = parseFloat(args[++i]);
        break;
      case "--min-ram":
        result.minRam = parseInt(args[++i]);
        break;
      case "--min-storage":
        result.minStorage = parseInt(args[++i]);
        break;
      case "--ecc-only":
        result.eccOnly = true;
        break;
      case "--nvme-only":
        result.nvmeOnly = true;
        break;
      case "--summary":
        result.summary = true;
        break;
      case "--json":
        result.json = true;
        break;
      case "--llm":
        result.llm = true;
        break;
      case "--help":
      case "-h":
        result.help = true;
        break;
    }
  }

  return result;
}

/** Log to stderr so it doesn't pollute stdout when piping (--llm, --json) */
function log(msg: string) {
  Deno.stderr.writeSync(new TextEncoder().encode(msg + "\n"));
}

async function main() {
  const args = parseArgs(Deno.args);

  if (args.help) {
    printUsage();
    Deno.exit(0);
  }

  // Fetch all sources in parallel
  log("Fetching auction data from Hetzner, Gigahost, OVH Eco, and OneProvider...");
  const [hetznerServers, gigahostServers, ovhServers, oneProviderServers] = await Promise.all([
    fetchHetzner(),
    fetchGigahost(),
    fetchOvh(),
    fetchOneProvider(log),
  ]);
  log(
    `Fetched ${hetznerServers.length} from Hetzner, ${gigahostServers.length} from Gigahost, ${ovhServers.length} from OVH Eco, ${oneProviderServers.length} from OneProvider.`,
  );

  const allServers = [...hetznerServers, ...gigahostServers, ...ovhServers, ...oneProviderServers];
  let metrics = allServers.map(deriveMetrics);

  // Apply global filters
  if (args.provider) {
    metrics = metrics.filter(
      (m) => m.server.provider === args.provider,
    );
  }
  if (args.maxPrice !== undefined) {
    metrics = metrics.filter((m) => m.server.price <= args.maxPrice!);
  }
  if (args.minRam !== undefined) {
    metrics = metrics.filter(
      (m) => m.server.ram_size >= args.minRam!,
    );
  }
  if (args.minStorage !== undefined) {
    metrics = metrics.filter(
      (m) => m.totalStorageGB >= args.minStorage!,
    );
  }
  if (args.eccOnly) {
    metrics = metrics.filter((m) => m.hasECC);
  }
  if (args.nvmeOnly) {
    metrics = metrics.filter(
      (m) => m.nvmeGB > 0 && m.sataGB === 0 && m.hddGB === 0,
    );
  }

  if (args.llm) {
    outputLlmPrompt(metrics, args);
    return;
  }

  if (args.json) {
    outputJson(metrics, args);
    return;
  }

  if (args.summary) {
    displaySummary(metrics);
    return;
  }

  if (args.useCase) {
    displayResults(
      args.useCase,
      metrics,
      args.limit,
      args.location,
      args.provider,
    );
  } else {
    displaySummary(metrics);
    for (const uc of Object.keys(useCases) as UseCase[]) {
      displayResults(uc, metrics, args.limit, args.location, args.provider);
    }
  }
}

function outputLlmPrompt(metrics: ServerMetrics[], args: ParsedArgs) {
  const cases = args.useCase
    ? [args.useCase]
    : (Object.keys(useCases) as UseCase[]);

  const sections: string[] = [];

  for (const uc of cases) {
    const config = useCases[uc];
    let filtered = metrics.filter(config.filter);
    if (args.location) {
      filtered = filtered.filter(
        (m) => m.location.toUpperCase() === args.location!.toUpperCase(),
      );
    }
    if (args.provider) {
      filtered = filtered.filter(
        (m) => m.server.provider === args.provider,
      );
    }
    filtered.sort(config.sort);
    const top = filtered.slice(0, args.limit);

    if (top.length === 0) continue;

    const serverRows = top.map((m) => ({
      id: m.server.id,
      provider: m.server.provider,
      cpu: m.server.cpu,
      cores: m.cpuCores,
      ram_gb: m.server.ram_size,
      ecc: m.hasECC,
      gpu: m.hasGPU,
      gpu_model: m.gpuModel,
      total_storage_gb: m.totalStorageGB,
      storage_type: m.storageType,
      nvme_gb: m.nvmeGB,
      sata_ssd_gb: m.sataGB,
      hdd_gb: m.hddGB,
      disk_count: m.server.hdd_count,
      datacenter: m.server.datacenter,
      location: m.location,
      price_eur_per_month: m.server.price,
      price_eur_per_month_annual:
        m.server.provider === "gigahost"
          ? round2(m.server.price * (1 - GIGAHOST_ANNUAL_DISCOUNT))
          : null,
      price_per_tb: round2(m.pricePerTB),
      price_per_gb_ram: round2(m.pricePerGBRam),
      price_per_core: round2(m.pricePerCore),
      fixed_price: m.server.fixed_price,
      url: m.server.url,
    }));

    sections.push(
      `## ${config.label}\n\n` +
        `Use-case description: ${config.description}\n` +
        `Matched servers: ${filtered.length} (showing top ${top.length})\n\n` +
        "```json\n" +
        JSON.stringify(serverRows, null, 2) +
        "\n```",
    );
  }

  const useCaseContext: Record<UseCase, string> = {
    compute:
      "Dina runs containerized workloads and managed Kubernetes. Prioritize high core count, adequate RAM (32+ GB), and fast NVMe storage for container image layers. Price per core is the key efficiency metric.",
    database:
      "Dina offers managed SQL databases (PostgreSQL). Prioritize ECC RAM (data integrity), large RAM for buffer pools (64+ GB), and fast SSD/NVMe storage. Price per GB of RAM is the key metric. RAID-capable multi-disk setups are preferred.",
    "object-storage":
      "Dina offers S3-compatible object storage (MinIO). Prioritize maximum raw HDD capacity at the lowest cost per TB. CPU and RAM requirements are modest. Look for servers with many large HDDs.",
    cache:
      "Dina offers managed key-value stores (Redis/Valkey). Prioritize maximum RAM at the lowest price per GB, with fast SSD/NVMe for persistence. CPU needs are moderate.",
    "ai-inference":
      "Dina hosts LLMs for on-premise inference. For CPU inference (llama.cpp), maximum RAM is critical (model weights must fit in memory — a 70B model needs ~40-140 GB). Many cores help with throughput. GPU servers are ideal if available. Large NVMe for model storage.",
    "simulation-testing":
      "Dina runs simulation testing and fuzzing workloads (AFL++, libFuzzer, custom harnesses). Fuzzing is embarrassingly parallel — maximize core count for concurrent fuzz instances. Each instance needs moderate RAM (32+ GB total). Fast NVMe is important for corpus storage and crash dump I/O. Price per core is the key metric.",
    observability:
      "Dina runs centralized logging, metrics, and tracing (Loki, Prometheus, Jaeger). Prioritize large SSD storage for time-series data and log indices, with good RAM (64+ GB) for indexing. Price per TB of SSD is the key metric.",
  };

  const contextLines = cases
    .map((uc) => `- **${useCases[uc].label}**: ${useCaseContext[uc]}`)
    .join("\n");

  const filtersApplied = [
    args.location && `location: ${args.location}`,
    args.provider && `provider: ${args.provider}`,
    args.maxPrice !== undefined && `max price: €${args.maxPrice}/mo`,
    args.minRam !== undefined && `min RAM: ${args.minRam} GB`,
    args.minStorage !== undefined && `min storage: ${args.minStorage} GB`,
    args.eccOnly && "ECC only",
    args.nvmeOnly && "NVMe only",
  ]
    .filter(Boolean)
    .join(", ");

  const prompt = `You are a senior infrastructure engineer helping Dina, a managed cloud platform competing with hyperscalers (AWS, GCP, Azure). Dina builds its services on top of dedicated servers from auction marketplaces (Hetzner, Gigahost) and discount providers (OVH Eco, OneProvider).

Your task is to analyze the server auction data below and recommend the best options.

# Context

Dina offers these managed services that need bare-metal infrastructure:
${contextLines}

All prices are normalized to EUR/month. Gigahost prices are converted from NOK at ${NOK_TO_EUR} NOK/EUR.
Gigahost offers a 15% discount when paying annually (shown as \`price_eur_per_month_annual\` where applicable).
Providers: HZ = Hetzner (DE/FI datacenters), GH = Gigahost (NO/NL datacenters), OVH = OVH Eco (FR/DE/PL datacenters), OP = OneProvider (EU-wide datacenters).
${filtersApplied ? `\nActive filters: ${filtersApplied}` : ""}

# Server Data

${sections.join("\n\n")}

# Instructions

For each use-case category above:

1. **Top picks**: Recommend your top 3 servers with a brief justification for each (value, specs, trade-offs).
2. **Best value**: Which single server offers the best price-to-performance ratio for this workload?
3. **Best performance**: Which single server offers the best raw performance regardless of price?
4. **Watch out**: Flag any servers that look like a good deal but have a hidden weakness for this workload (e.g. low RAM for a database, slow HDD for compute).
5. **Cross-provider comparison**: If multiple providers have matching servers, compare them.

Keep your analysis concise and actionable. Use specific server IDs and include the \`url\` field as a clickable link so Dina can act on your recommendations directly.`;

  console.log(prompt);
}

function outputJson(metrics: ServerMetrics[], args: ParsedArgs) {
  const cases = args.useCase
    ? [args.useCase]
    : (Object.keys(useCases) as UseCase[]);
  const result: Record<string, unknown[]> = {};

  for (const uc of cases) {
    const config = useCases[uc];
    let filtered = metrics.filter(config.filter);
    if (args.location) {
      filtered = filtered.filter(
        (m) => m.location.toUpperCase() === args.location!.toUpperCase(),
      );
    }
    filtered.sort(config.sort);
    result[uc] = filtered.slice(0, args.limit).map((m) => ({
      id: m.server.id,
      provider: m.server.provider,
      cpu: m.server.cpu,
      cpuCores: m.cpuCores,
      ramGB: m.server.ram_size,
      ecc: m.hasECC,
      gpu: m.hasGPU,
      gpuModel: m.gpuModel,
      totalStorageGB: m.totalStorageGB,
      storageType: m.storageType,
      nvmeGB: m.nvmeGB,
      sataGB: m.sataGB,
      hddGB: m.hddGB,
      diskCount: m.server.hdd_count,
      datacenter: m.server.datacenter,
      location: m.location,
      priceEUR: m.server.price,
      priceOriginal: m.server.priceOriginal,
      currency: m.server.currency,
      pricePerTB: round2(m.pricePerTB),
      pricePerGBRam: round2(m.pricePerGBRam),
      pricePerCore: round2(m.pricePerCore),
      fixedPrice: m.server.fixed_price,
      url: m.server.url,
      ...config.columns(m),
    }));
  }

  console.log(JSON.stringify(result, null, 2));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

main();
