# Shopify Variant Enrichment on AWS EC2 (Ubuntu + PM2)

This project:
- Fetches Shopify products and variants filtered by tag/status.
- Flattens to variant-level JSON.
- Enriches each variant with `productSpecifications` from McKesson pages.
- Supports parallel, range-based processing with PM2.
- Provides status reporting per range.

## 1. Server Prerequisites (EC2 Ubuntu)

```bash
sudo apt update
sudo apt install -y curl git
```

Install Node.js LTS (Node 20 recommended):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

Install PM2 globally:

```bash
sudo npm install -g pm2
pm2 -v
```

## 2. Copy Project to EC2

Example with `scp`:

```bash
scp -r "./McKesson New Workflow" ubuntu@<EC2_PUBLIC_IP>:~/
```

On EC2:

```bash
cd ~/"McKesson New Workflow"
ls
```

## 3. Configure Environment

Create `.env` (or update existing one):

```bash
cat > .env << 'EOF'
ACCESS_TOKEN=YOUR_SHOPIFY_ADMIN_TOKEN
SHOP=behope-ca
API_VERSION=2025-10
TAG=7775
PRODUCT_SUPPLIER_METAFIELD_NAMESPACE=custom
PRODUCT_SUPPLIER_METAFIELD_KEY=supplier_id
VARIANT_SUPPLIER_METAFIELD_NAMESPACE=custom
VARIANT_SUPPLIER_METAFIELD_KEY=supplierid
OUTPUT_FILE=shopify_products.json
EOF
```

## 4. Generate Base Files (if not already present)

### 4.1 Fetch Shopify products

```bash
node shopify_fetch_products.js
```

This generates `shopify_products.json`.

### 4.2 Build variant-level input

If `shopify_variants.json` is not already available, create it from `shopify_products.json`:

```bash
node -e '
const fs=require("fs");
const data=JSON.parse(fs.readFileSync("shopify_products.json","utf8"));
const out=[];
for(const p of data){
  for(const v of p.variants||[]){
    out.push({
      variantId:v.id,
      supplierId:v.supplierId,
      title:p.title,
      price:v.price,
      productId:p.productId
    });
  }
}
fs.writeFileSync("shopify_variants.json", JSON.stringify(out, null, 2));
console.log("Wrote shopify_variants.json rows:", out.length);
'
```

## 5. Run 5 PM2 Processes in Parallel (Range-Based)

Input size used for splitting: `37354` variants.

Chosen ranges:
- Process 1: `1-7471`
- Process 2: `7472-14942`
- Process 3: `14943-22413`
- Process 4: `22414-29884`
- Process 5: `29885-37354`

Start all 5 workers:

```bash
pm2 start enrich_variants_with_specs.js --name specs-1-7471 -- --start_line 1 --end_line 7471
pm2 start enrich_variants_with_specs.js --name specs-7472-14942 -- --start_line 7472 --end_line 14942
pm2 start enrich_variants_with_specs.js --name specs-14943-22413 -- --start_line 14943 --end_line 22413
pm2 start enrich_variants_with_specs.js --name specs-22414-29884 -- --start_line 22414 --end_line 29884
pm2 start enrich_variants_with_specs.js --name specs-29885-37354 -- --start_line 29885 --end_line 37354
```

Each process writes isolated files automatically:
- Results: `results_<start>_<end>.jsonl`
- Logs: `logs_<start>_<end>.log`

This avoids race conditions because no two processes write to the same files.

## 6. Monitor Progress

PM2 process status:

```bash
pm2 ls
pm2 logs --lines 50
```

Range-level progress report:

```bash
node range_status.js
```

This writes `status_report.json` with:
- done/remaining per range
- active/working state per range
- failure counters

## 7. Auto-Start PM2 on Reboot

```bash
pm2 save
pm2 startup
```

Run the command printed by `pm2 startup` (with sudo), then:

```bash
pm2 save
```

## 8. Resume / Retry Behavior

- Re-running the same range appends to that range's files and resumes using the range log.
- To restart a range from scratch, delete that range's files first:

```bash
rm -f results_1_7471.jsonl logs_1_7471.log
pm2 restart specs-1-7471
```

## 9. Merge Results After All Ranges Complete (Optional)

Combine all range JSONL files into one JSON array:

```bash
node -e '
const fs=require("fs");
const path=require("path");
const files=fs.readdirSync(".").filter(f=>/^results_\d+_(\d+|end)\.jsonl$/i.test(f)).sort();
const all=[];
for(const f of files){
  const lines=fs.readFileSync(path.join(".",f),"utf8").split(/\r?\n/).filter(Boolean);
  for(const line of lines) all.push(JSON.parse(line));
}
fs.writeFileSync("shopify_variants_with_specs_merged.json", JSON.stringify(all, null, 2));
console.log("Merged rows:", all.length);
'
```

## Compatibility Notes

- Works on Linux/Ubuntu (EC2) with Node.js 18+ (`fetch` support is required).
- Node 20 LTS is recommended.
- No external npm dependencies are required.
