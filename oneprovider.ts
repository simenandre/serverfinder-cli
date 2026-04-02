/**
 * OneProvider dedicated server scraper.
 *
 * Scrapes server listings from oneprovider.com location pages.
 * Prices are in EUR. Only EU locations are fetched.
 */

const ONEPROVIDER_BASE = "https://oneprovider.com/en/dedicated-servers";

// Curated EU locations relevant for Dina infrastructure
const EU_LOCATIONS: { slug: string; name: string; code: string }[] = [
  { slug: "amsterdam-netherlands", name: "Amsterdam", code: "NL" },
  { slug: "paris-france", name: "Paris", code: "FR" },
  { slug: "frankfurt-germany", name: "Frankfurt", code: "DE" },
  { slug: "warsaw-poland", name: "Warsaw", code: "PL" },
  { slug: "london-united-kingdom", name: "London", code: "GB" },
  { slug: "brussels-belgium", name: "Brussels", code: "BE" },
  { slug: "zurich-switzerland", name: "Zurich", code: "CH" },
  { slug: "milan-italy", name: "Milan", code: "IT" },
  { slug: "madrid-spain", name: "Madrid", code: "ES" },
  { slug: "bucharest-romania", name: "Bucharest", code: "RO" },
  { slug: "sofia-bulgaria", name: "Sofia", code: "BG" },
  { slug: "stockholm-sweden", name: "Stockholm", code: "SE" },
  { slug: "oslo-norway", name: "Oslo", code: "NO" },
  { slug: "helsinki-finland", name: "Helsinki", code: "FI" },
  { slug: "copenhagen-denmark", name: "Copenhagen", code: "DK" },
  { slug: "vienna-austria", name: "Vienna", code: "AT" },
  { slug: "dublin-ireland", name: "Dublin", code: "IE" },
  { slug: "lisbon-portugal", name: "Lisbon", code: "PT" },
  { slug: "prague-czech-republic", name: "Prague", code: "CZ" },
];

interface ServerDiskData {
  nvme: number[];
  sata: number[];
  hdd: number[];
  general: number[];
}

interface AuctionServer {
  id: number;
  provider: "hetzner" | "gigahost" | "ovh" | "oneprovider";
  cpu: string;
  cpu_count: number;
  ram_size: number;
  is_ecc: boolean;
  price: number;
  priceOriginal: number;
  currency: "EUR" | "NOK";
  hdd_size: number;
  hdd_count: number;
  hdd_arr: string[];
  serverDiskData: ServerDiskData;
  datacenter: string;
  bandwidth: number;
  specials: string[];
  fixed_price: boolean;
  gpu_model: string | null;
  known_cores?: number;
  url: string;
}

/** Parse only the first drive option from the storage section (drives are alternatives separated by "or") */
function parseStorage(html: string): { diskData: ServerDiskData; hddArr: string[] } {
  const result: ServerDiskData = { nvme: [], sata: [], hdd: [], general: [] };
  const hddArr: string[] = [];

  // Extract only the res-storage section
  const storageSection = html.match(/res-storage[\s\S]*?<\/div>\s*<\/div>/i);
  if (!storageSection) return { diskData: result, hddArr };

  // Get the first drive option only (before "or" separator)
  const firstDriveBlock = storageSection[0].split(/drive-separator-or/)[0];

  // Match: <span class="unit">2x</span> ... <span class="digits">2</span><span class="unit">TB</span> ... (HDD SATA)
  const countMatch = firstDriveBlock.match(/<span[^>]*class="unit"[^>]*>(\d+)x<\/span>/);
  const count = countMatch ? parseInt(countMatch[1]) : 1;

  const capMatch = firstDriveBlock.match(
    /<span[^>]*class="digits"[^>]*>(\d+(?:\.\d+)?)<\/span>\s*<span[^>]*class="unit"[^>]*>(TB|GB)<\/span>/i,
  );
  if (!capMatch) return { diskData: result, hddArr };

  let sizeGB = parseFloat(capMatch[1]);
  if (capMatch[2].toUpperCase() === "TB") sizeGB *= 1000;

  // Type is split across two spans: "(SSD" and "NVMe)" or "(HDD" and "SATA)"
  const typeSpans = firstDriveBlock.match(
    /\(?(NVMe|SSD|HDD)\)?\s*<\/span>\s*(?:<span[^>]*class="unit"[^>]*>\(?(SATA|NVMe|SAS)?\)?<\/span>)?/i,
  );
  const type1 = (typeSpans?.[1] ?? "").toUpperCase();
  const type2 = (typeSpans?.[2] ?? "").toUpperCase();

  const sizes = Array(count).fill(sizeGB);
  const label = `${count > 1 ? count + "x " : ""}${capMatch[1]}${capMatch[2]} ${type1}${type2 ? " " + type2 : ""}`;
  hddArr.push(label);

  if (type1 === "NVME" || type2 === "NVME") {
    result.nvme.push(...sizes);
  } else if (type1 === "SSD") {
    result.sata.push(...sizes);
  } else if (type1 === "HDD") {
    result.hdd.push(...sizes);
  } else {
    result.sata.push(...sizes);
  }

  return { diskData: result, hddArr };
}

function parseEurPrice(html: string): number {
  // EUR class may have currency-default between currency and currency-code-eur
  const eurBlock = html.match(
    /class="currency[^"]*currency-code-eur[^"]*"[\s\S]*?<\/div>/i,
  );
  if (!eurBlock) return 0;

  const block = eurBlock[0];

  // Try discounted price first (price-new-amount)
  // Amounts may contain comma thousands separators, e.g. "1,139"
  const discounted = block.match(
    /price-new-amount[\s\S]*?price-amount[^>]*>([\d,]+)[\s\S]*?price-cent[^>]*>(\d+)/,
  );
  if (discounted) {
    return parseInt(discounted[1].replace(/,/g, "")) + parseInt(discounted[2]) / 100;
  }

  // Fall back to normal price
  const normal = block.match(
    /price-amount[^>]*>([\d,]+)[\s\S]*?price-cent[^>]*>(\d+)/,
  );
  if (normal) {
    return parseInt(normal[1].replace(/,/g, "")) + parseInt(normal[2]) / 100;
  }

  return 0;
}

function parseBandwidth(html: string): { speed: number; unmetered: boolean } {
  const speedMatch = html.match(
    /field--bw-speed[\s\S]*?digits[^>]*>(\d+)[\s\S]*?unit[^>]*>(Gbps|Mbps)/i,
  );
  const speed = speedMatch
    ? parseInt(speedMatch[1]) * (speedMatch[2].toLowerCase() === "gbps" ? 1000 : 1)
    : 1000;
  const unmetered = /Unmetered/i.test(html);
  return { speed, unmetered };
}

function parseCoresThreads(html: string): { cores: number; threads: number } {
  const match = html.match(/(\d+)c\/(\d+)t/);
  return match
    ? { cores: parseInt(match[1]), threads: parseInt(match[2]) }
    : { cores: 0, threads: 0 };
}

function isDedicatedAndInStock(row: string): boolean {
  // Skip virtual servers
  if (/class="[^"]*virtual-server[^"]*"/.test(row)) return false;
  return /data-tooltip="In Stock"|data-tooltip="Limited Quantity"/.test(row);
}

function parseLocationPage(
  html: string,
  location: { name: string; code: string },
): AuctionServer[] {
  const servers: AuctionServer[] = [];

  // Split on each server row
  const rows = html.split(/(?=<div[^>]*class="[^"]*results-tr[^"]*"[^>]*data-p)/);

  for (const row of rows) {
    const pidMatch = row.match(/data-pid="(\d+)"/);
    if (!pidMatch) continue;

    if (!isDedicatedAndInStock(row)) continue;

    const pid = parseInt(pidMatch[1]);

    // Parse analytics JSON for structured CPU/RAM data
    const analyticsMatch = row.match(/data-analytics='(\{[^']+\})'/);
    let cpuName = "";
    let cpuCount = 1;
    let ramSize = 0;

    if (analyticsMatch) {
      try {
        const analytics = JSON.parse(analyticsMatch[1]);
        cpuName = `${analytics.cpu?.maker ?? ""} ${analytics.cpu?.model ?? ""}`.trim();
        ramSize = (analytics.ram ?? 0) / 1024; // MB → GB
      } catch { /* fall through to HTML parsing */ }
    }

    // Fallback: parse CPU from HTML
    if (!cpuName) {
      const cpuNameMatch = row.match(/field-cpu-name[^>]*>([^<]+)/);
      cpuName = cpuNameMatch ? cpuNameMatch[1].trim() : "Unknown";
    }

    // Dual CPU detection
    if (/cpu-amount-2/.test(row)) cpuCount = 2;

    // Fallback: parse RAM from HTML
    if (!ramSize) {
      const ramMatch = row.match(
        /res-memory[\s\S]*?digits[^>]*>(\d+)[\s\S]*?unit[^>]*>(GB|TB)/i,
      );
      if (ramMatch) {
        ramSize = parseInt(ramMatch[1]);
        if (ramMatch[2].toUpperCase() === "TB") ramSize *= 1024;
      }
    }

    const { cores } = parseCoresThreads(row);
    const price = parseEurPrice(row);
    if (price <= 0) continue;

    const { diskData, hddArr } = parseStorage(row);
    const allDisks = [...diskData.nvme, ...diskData.sata, ...diskData.hdd];
    const bw = parseBandwidth(row);

    const isEcc = cpuName.includes("Xeon") || cpuName.includes("EPYC");

    servers.push({
      id: pid,
      provider: "oneprovider",
      cpu: cpuName,
      cpu_count: cpuCount,
      ram_size: ramSize,
      is_ecc: isEcc,
      price,
      priceOriginal: price,
      currency: "EUR",
      hdd_size: allDisks[0] ?? 0,
      hdd_count: allDisks.length,
      hdd_arr: hddArr,
      serverDiskData: diskData,
      datacenter: `${location.name}, ${location.code}`,
      bandwidth: bw.speed,
      specials: bw.unmetered ? ["unmetered"] : [],
      fixed_price: true,
      gpu_model: null,
      known_cores: cores > 0 ? cores * cpuCount : undefined,
      url: `https://oneprovider.com/en/configure/dediconf/${pid}`,
    });
  }

  return servers;
}

export async function fetchOneProvider(
  log: (msg: string) => void = () => {},
): Promise<AuctionServer[]> {
  const allServers: AuctionServer[] = [];

  const results = await Promise.allSettled(
    EU_LOCATIONS.map(async (loc) => {
      const url = `${ONEPROVIDER_BASE}/${loc.slug}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        log(`OneProvider: failed to fetch ${loc.name}: ${resp.status}`);
        return [];
      }
      const html = await resp.text();
      return parseLocationPage(html, loc);
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      allServers.push(...result.value);
    }
  }

  return allServers;
}
