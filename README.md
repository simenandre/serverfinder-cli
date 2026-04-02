# Server Finder CLI

CLI tool that fetches and compares dedicated server auctions from Hetzner, Gigahost, OVH Eco, and OneProvider. Servers are normalized into a common format and ranked by use-case (compute, database, object-storage, cache, AI inference, observability, git-hosting).

## Usage

```sh
deno run --allow-net main.ts [options]
```

### Options

| Flag | Description |
| --- | --- |
| `--use-case <name>` | Filter for a specific use case |
| `--limit <n>` | Results per category (default: 15) |
| `--location <loc>` | Filter by datacenter location (FSN, NBG, HEL, ...) |
| `--provider <name>` | Filter by provider (hetzner, gigahost, ovh, oneprovider) |
| `--max-price <eur>` | Maximum monthly price in EUR |
| `--min-ram <gb>` | Minimum RAM in GB |
| `--min-storage <gb>` | Minimum total storage in GB |
| `--ecc-only` | Only ECC RAM servers |
| `--nvme-only` | Only NVMe storage servers |
| `--optimize-latency` | Measure datacenter latency and factor into ranking |
| `--max-latency <ms>` | Filter by max latency (implies `--optimize-latency`) |
| `--summary` | Show market summary only |
| `--json` | Output as JSON |
| `--llm` | Output a prompt for piping to an LLM |

### Examples

```sh
deno run --allow-net main.ts --use-case object-storage --limit 20
deno run --allow-net main.ts --use-case database --location FSN --ecc-only
deno run --allow-net main.ts --provider gigahost --summary
deno run --allow-net main.ts --use-case compute --llm | claude
```
