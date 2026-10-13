# Napcat Manufacturing — Invoice, Tally WO & Claude check: setup

Do these steps once, in this order. Total time: about 30 minutes.

## 1. Put the new app on GitHub (5 min)
1. Open github.com/pranavkrishna2014-ai/Napcat-Manufacturing-app.
2. Click **Add file → Upload files** and drag in `index.html` plus the whole `supabase` folder (and this `SETUP.md`).
3. Click **Commit changes**. Cloudflare redeploys within a minute.

The app keeps working as before. The Invoice and Tally WO tabs show
"storage not set up" until step 2 is done.

## 2. Create the storage in Supabase (5 min)
1. Open supabase.com/dashboard and pick the manufacturing project (`cwezzjmifaydqiamudfk`).
2. Go to **SQL Editor → New query**, paste everything from `supabase/setup.sql`, and click **Run**.
3. Reload the app. The Invoice and Tally WO tabs now accept PDF uploads.

## 3. Create office logins (2 min)
Log in as admin and go to **Admin Control → Users → New user**, then choose the role **Office**.
- **Office:** everything an operator can do, plus upload Invoice / Tally WO PDFs and run the Claude check.
- **Operator:** can see the invoices, Tally WOs and check results, but can't upload or delete.
- **Admin:** everything.

## 4. Get a Claude API key (10 min)
1. Go to **platform.claude.com** (Claude Console) and sign up with your work email.
2. Go to **Settings → Billing** and buy prepaid credits. $5–10 is plenty to start.
3. Go to **Settings → Limits** and set a **monthly spend limit** (for example $20) so the bill can never surprise you.
4. Go to **API keys → Create key**, name it `napcat-manufacturing`, and copy the key (starts with `sk-ant-`).
   You only see it once, and it should never go into index.html or GitHub.

Cost: each check is roughly ₹2–4 with Claude Sonnet (a 1–3 page PDF).
500 checks a month comes to about ₹1,000–1,500.

## 5. Connect Claude to the app (8 min)
In the Supabase dashboard for the manufacturing project:
1. Go to **Edge Functions → Secrets → Add new secret**.
   Name: `ANTHROPIC_API_KEY`. Value: the key from step 4. Save.
2. Go to **Edge Functions → Deploy a new function → Via Editor**.
   - Function name: `check-doc` (exactly this).
   - Delete the sample code, paste everything from `supabase/functions/check-doc/index.ts`, and click **Deploy**.
3. Open the function's **Details / Settings** and turn **OFF "Verify JWT"** (Enforce JWT verification). Save.
   The app has its own logins, and the function checks your project key itself.

## 6. Test
1. Log in as an Office user, then go to **Workorder → Invoice → Upload Invoice PDF**.
2. Pick a work order, type the invoice number, choose the PDF, and keep "Check with Claude" ticked. Click **Upload**.
3. After 10–30 seconds the result opens: ✓ Matches / ⚠ Differences, with a line-by-line table.
4. In **View / Edit Orders**, each work order shows its Invoice and Tally WO status on the same line.

If the check fails, the app shows the reason. Common ones:
- "ANTHROPIC_API_KEY secret is not set": repeat step 5.1.
- "Claude API error: credit balance is too low": add credits (step 4.2).
- "Function not found" / 404: the function name must be exactly `check-doc`.
- 401 errors: turn off "Verify JWT" (step 5.3).

## Optional settings
- To use a different Claude model, add the secret `CLAUDE_MODEL` (default `claude-sonnet-5-5`).
  `claude-haiku-5-5` is cheaper; `claude-opus-5-5` is the most careful.
- The PDF size limit is 10 MB. Only PDFs are accepted.
