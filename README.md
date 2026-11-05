# Geboortelijst

A baby gift list in the style of pakske.be. Guests can buy a whole gift or chip in part of it, and pay by scanning an EPC/SEPA QR code in their banking app, with no payment fees. **Everything updates live**: as soon as someone contributes, every open page shows it. You only need Node.js 18 or newer; nothing has to be installed with npm.

## Files

| File | Purpose |
|------|---------|
| `config.json` | Title, intro text, header picture, **your IBAN / beneficiary name** (BIC optional) |
| `gifts.json` | The **starting list**. It's copied into the data folder on the very first start; after that you manage gifts in `/admin` |
| `data/` | The live data: `gifts.json` and `contributions.json`. Written by the server, not in git. On Railway this is the volume |
| `public/` | The website itself (HTML, CSS, JS, images) |
| `package.json` | Tells Railway how to start the site (`npm start`) |

## Run it locally

```powershell
$env:ADMIN_PASSWORD="choose-something"; npm start
```

* Site: http://localhost:3000
* Admin: http://localhost:3000/admin (only works when `ADMIN_PASSWORD` is set)
* Other port: `$env:PORT=8080; npm start`

## Publishing on Railway (about $5/month)

### 1. Put the code on GitHub

1. Create a free account on https://github.com.
2. Click **New repository**, choose a name (e.g. `geboortelijst`), select **Private**, then **Create repository**.
3. Upload the files: on the empty repository page, click **uploading an existing file**. Drag in everything from this folder (`public`, `config.json`, `gifts.json`, `package.json`, `server.js`, `README.md`, `.gitignore`), then **Commit changes**.
   * Windows hides `.gitignore` by default. It's not essential, but it prevents a local `data` folder from ending up in git.
   * Easier in the long run: use [GitHub Desktop](https://desktop.github.com). Choose **Add local repository** → this folder → **Publish repository**.

### 2. Create the project on Railway

1. Go to https://railway.com and sign in with **Login with GitHub**.
2. Choose the **Hobby** plan ($5/month, usage included) under **Account → Plans**.
3. Click **New Project** → **Deploy from GitHub repo**, then pick your repository. If it isn't listed, use **Configure GitHub App** to give Railway access to it.
4. Railway sees `package.json` and starts the site with `npm start`. The first deploy takes a minute or two.

### 3. Set the admin password

Click the service → **Variables** tab → **New Variable**:

| Name | Value |
|------|-------|
| `ADMIN_PASSWORD` | a strong password of your choice |

Railway redeploys automatically.

### 4. Add a volume (important!)

Without a volume, all contributions and gift changes are **lost on every update**.

1. In your project, right-click the empty canvas, or press `Ctrl+K`, and choose **New Volume** (or **Add Volume**).
2. Attach it to your service, with mount path `/data`.
3. That's all. Railway passes the volume's location to the server automatically (`RAILWAY_VOLUME_MOUNT_PATH`). On first start, the server copies `gifts.json` into it. In the deploy logs you'll see `Gegevens in: /data` ("data stored in: /data").

### 5. Get a web address

Service → **Settings** → **Networking** → **Generate Domain**. You get something like `https://geboortelijst-production.up.railway.app`. HTTPS is included.

* The guest list is that address.
* Admin is the same address + `/admin`.
* Want your own domain (e.g. `geboortelijst-baby.be`)? Use **Custom Domain** in the same place, and Railway shows the DNS record to add at your domain registrar.

### 6. Check it works

1. Open `/admin`, log in, and add a test gift.
2. Open the list on your phone and make a test contribution.
3. Trigger a redeploy (**Deployments** → ⋮ → **Redeploy**). The test gift and contribution should still be there. If so, the volume works.
4. Remove the test gift and contribution in `/admin`.

### Making changes later

* **Gifts:** always through `/admin`. No redeploy needed.
* **Text, IBAN, picture, layout** (`config.json`, `public/`): change the file on GitHub (pencil icon → **Commit changes**). Railway redeploys automatically within a minute, and your data on the volume stays intact.
* **Editing `gifts.json` in the repository has no effect after the first start**, because the live list lives on the volume. Use `/admin` instead.

### Costs and backups

* Check **Usage** in Railway now and then. This site should stay well within the $5 included in Hobby.
* Make a backup now and then: `/admin` → **Bijdragen** (contributions) → **Download back-up**. This saves all gifts and contributions in one JSON file.

## Adding gifts

The easiest way is the **Cadeaus** (gifts) tab in `/admin`: fill in a name, price and optionally a category, description, **one or more image links** and a link to the product. Use **+ Nog een afbeelding** (add another image) for extra photos and the arrows to change the order; the first image is the main one. Guests can browse through the images on the card (arrows, dots, or swiping on a phone), and the images are shown in the popup too. You can edit and delete gifts there too. Deleting is blocked while a gift still has contributions.

To get an image link: right-click a product photo in a web shop, then **Copy image address**. Each link gets a small preview, and a link that doesn't work is marked in red.

### Your own photos (not online)

1. Put the files in `public/images/`, preferably in the `cadeaus` subfolder: e.g. `public/images/cadeaus/kinderwagen-1.jpg`. JPG, PNG, WebP, GIF and SVG all work. Use dashes instead of spaces in file names.
2. Refer to them **without** `public/`: `images/cadeaus/kinderwagen-1.jpg`. Do this in `/admin` (paste it into an image row), or in `gifts.json`. You can mix your own files and online links on one gift:

```json
"images": [
  "images/cadeaus/kinderwagen-groen.svg",
  "images/cadeaus/kinderwagen-perzik.svg",
  "https://www.example-shop.be/foto/kinderwagen-zijkant.jpg"
]
```

3. On Railway, the photos are part of the code: put them on GitHub (in `public/images/cadeaus/`) and Railway redeploys automatically. Then add the path to the gift in `/admin`.

The starting list includes an example: the **Kinderwagen** (pram) has three local images (`public/images/cadeaus/kinderwagen-*.svg`). Replace them with your own photos.

**Note:** `gifts.json` in the repository is only copied on the very first start. If the site is already running, editing that file has no effect; add images through `/admin` instead.

Options per gift:

* **Favoriet** (favourite): the gift gets a "♥ Favoriet" badge and appears first within its category. Guests can tick "Toon enkel onze favorieten" (show only our favourites) at the top of the list.
* **Gasten mogen een deel bijdragen** (guests may contribute part): when this is off, the gift can only be paid in full.
* **Enkel bijdragen** (contributions only): guests can't buy the whole gift themselves ("Ik koop het zelf"); they can only contribute money.
* **Markeer als volledig gekocht** (mark as fully bought): for when someone tells you in person that they're buying it.

As soon as anyone has contributed to a gift, "Ik koop het zelf" disappears for that gift. From then on guests can only contribute the rest, or part of it.

## Header picture

The two elephants at the top are `public/images/olifantje.svg`. To use a different picture, put it in `public/images/` and set `"heroImage": "images/your-picture.png"` in `config.json`. Set it to `""` to hide the picture.

The jungle decorations (leaves, hot-air balloon, dotted flight route, baby giraffe and lion cub) are `jungle-leaves.svg`, `hot-air-balloon.svg`, `route-plane.svg`, `giraffe.svg` and `lion.svg` in `public/images/`. Colours and fonts are set at the top of `public/style.css`.

## How it works for guests

1. A guest chooses a gift, then an amount (or the whole gift) and their name, and clicks **Verder** (next). **Nothing is saved yet.**
2. **Contribute by bank transfer:** they see a QR code with your IBAN, the amount and a payment reference like `Geboortelijst 6VJ762 Kinderwagen - Oma`. After paying, they click **Ik heb betaald** (I've paid). Only then is the contribution added to the list, live for everyone. **Annuleren** (cancel), or closing the popup, saves nothing.
3. **"Ik koop het zelf"** (I'll buy it myself): they see a short summary and click **Bevestigen** (confirm). The whole gift is then reserved in their name.
4. **Someone else got there first?** While the QR code is on screen, the guest gets a warning if the gift fills up meanwhile. If they had already paid and confirm anyway, the payment is still recorded (money is never lost), but marked **⚠ te veel** (too much) in `/admin`, so you know to sort it out.
## Your routine

* Open `/admin` → **Bijdragen** (contributions). It updates live too. When a transfer arrives, find its reference and tick **Betaald** (paid).
* If someone reserves but never pays, click **Verwijderen** (delete). The amount immediately becomes available on the list again.
