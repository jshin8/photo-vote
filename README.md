# Photo Vote

A small site for a photo vote. The admin uploads photos on `/admin/`; voters open the landing page, enter their name and vote. The admin decides when results are revealed.

- **Voting page** (`/`): asks for the voter's name, then shows the photos. One vote per browser, changeable until results are revealed. When the admin reveals results, voting closes and everyone sees the counts (the page updates on its own every few seconds).
- **Admin page** (`/admin/`): passcode login. Add and delete photos, see each photo's votes and voter names, and show/hide results.

- **Frontend:** Vite + TypeScript, static files hosted on GitHub Pages
- **Data:** Supabase. Postgres stores entries and votes, Storage holds the photos.
- **Admin access:** a shared passcode, stored hashed in a private schema. Every admin action is a database function that checks it, so the admin page itself grants nothing.
- **Voting rule:** one vote per browser. A random id is kept in `localStorage` and the database rejects a second vote from the same id. Clearing browser data or using another browser gets around this. That is the agreed trade-off for not requiring sign-in.

## One-time setup

### 1. Supabase

1. Create a free project at https://supabase.com.
2. Open **SQL Editor**, paste in [`supabase/schema.sql`](supabase/schema.sql), and run it. This creates the tables, the access rules, the `results()` function and the `photos` bucket.
3. In a new query, paste [`supabase/002_admin.sql`](supabase/002_admin.sql), replace `CHANGE-ME` at the bottom with your admin passcode, and run it. To change the passcode later, re-run just that last statement with a new value.
4. In **Project Settings → API**, copy the **Project URL** and the public **anon / publishable** key.

### 2. Local development

```sh
cp .env.example .env.local   # paste in the URL and key
npm install
npm run dev
```

### 3. GitHub Pages

1. In the repo on GitHub, open **Settings → Secrets and variables → Actions → Variables** and add:
   - `SUPABASE_URL`
   - `SUPABASE_KEY`
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Push to `main`. The workflow in `.github/workflows/deploy.yml` builds the site and deploys it to `https://<your-username>.github.io/photo-vote/`.

The public key ends up in the browser, so it isn't a secret. Row Level Security and the database functions control what visitors can do: read entries, cast or change their own vote while voting is open, and read the counts once results are revealed. Adding photos, deleting, seeing voter names, and the results switch all require the admin passcode.

## Removing photos

Delete a photo on `/admin/` (its votes go with it). Its file stays in the `photos` bucket in **Storage**, which is harmless; delete it there if you want to tidy up.
