# Photo Vote

A small site where people submit a name and a photo, vote for one entry, and see the results.

- **Frontend:** Vite + TypeScript, static files hosted on GitHub Pages
- **Data:** Supabase. Postgres stores entries and votes, Storage holds the photos.
- **Voting rule:** one vote per browser. A random id is kept in `localStorage` and the database rejects a second vote from the same id. Clearing browser data or using another browser gets around this. That is the agreed trade-off for not requiring sign-in.

## One-time setup

### 1. Supabase

1. Create a free project at https://supabase.com.
2. Open **SQL Editor**, paste in [`supabase/schema.sql`](supabase/schema.sql), and run it. This creates the tables, the access rules, the `results()` function and the `photos` bucket.
3. In **Project Settings → API**, copy the **Project URL** and the public **anon / publishable** key.

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

The public key ends up in the browser, so it isn't a secret. Row Level Security in `schema.sql` controls what visitors can do: read entries, add entries, upload photos, and cast votes. They can't read raw votes, change anything, or delete anything.

## Moderation

Anyone can submit entries. To remove one, delete its row in Supabase's **Table Editor** (its votes go with it) and delete its file from the `photos` bucket in **Storage**.
