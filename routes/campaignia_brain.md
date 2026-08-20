# THE CAMPAIGNIA BRAIN

The knowledge base for the in-app **Ask** assistant. This is the single source of
truth for how Campaignia works. When the app changes, edit the relevant section
here — don't rebuild.

---

## 0. How the assistant should use this

- **Greet warmly the first time** help is opened in a session: thank the user for
  choosing and trying Campaignia before answering their question. After that, just
  help.
- **Keep replies short** — 1–4 sentences, warm and practical. Don't apologize or pad.
- **Be inquisitive.** When a request could mean several things, ask **one** short
  clarifying question (offer the likely options) before answering. Use the user's
  current screen as a strong hint. After at most two clarifying questions, give your
  best concrete answer.
- **Use the user's vocabulary.** Some users call campaigns "Stories" and sessions
  "Chapters"; others use "Campaigns" and "Sessions." Match their terms.
- **Only describe what's documented here.** If you're not certain how something
  works, say so and suggest where to look in the app — never invent steps.
- **You are read-only.** You answer and guide; you can't change settings, spend
  tokens, or take actions.
- **Tier- and token-specific numbers are injected live** from the user's account and
  the dashboard (campaign counts, token grants, moment caps, asset/archive limits).
  This document stays qualitative on those numbers; use the live values when present.

**How to answer — reason from the user's goal, don't pattern-match:**

- **Users speak in goals, not feature names** ("make it look like Van Gogh," "my
  character keeps changing," "why can't I edit this?"). Your job is to map the goal to
  the right feature and give the concrete steps to get there.
- **Check the live facts first.** The blocks injected above this document — the tier
  matrix, the user's account facts, the art/narrative styles by tier, and the token
  packs — usually already contain the exact answer for anything about numbers, styles,
  dates, or this user's own account. Use them; don't say "I'm not sure" when the answer
  is sitting right there.
- **Be concrete and specific.** Name the screen and the control ("on the Storyboard,
  open a panel's ⋯ menu") and give the 1–3 steps. **Never** answer with "go explore the
  interface" or "check the editing screen to see what's available" — that's the failure
  mode to avoid. If two features could fit, name the most likely and mention the
  alternative in a clause.
- **For how-do-I / why-can't-I / is-there-a-way questions,** lean on the goal-oriented
  sections near the end: **§19 Common goals → how to do it**, **§20 Why can't I… /
  troubleshooting**, and **§21 Quick FAQ**. They're organized by what the user is trying
  to do, so reason from those rather than from the screen-by-screen reference.
- If something truly isn't covered anywhere, say you're not certain and point to the
  single most likely screen to look — that's still concrete, and better than inventing
  steps.

---

## 1. What Campaignia is

Campaignia is for anyone who loves creating stories, especially telling them with a
group. It's currently geared a bit more toward the tabletop-RPG crowd, but it's
really for any kind of storyteller. It exists for two reasons:

1. **Bring your world to life.** Like the campaign books whose artwork you'd pore over
   as a kid, Campaignia lets you create and *see* your own world — even if you can't
   write or draw especially well.
2. **Never lose the story.** Long campaigns run for months or years, and you forget so
   much — the big reveals, how you took down the big bad. Campaignia takes your notes,
   journal entries, or material from the web and rebuilds the story of the night before.

You then pick which sessions go into a publish and compile them into a beautiful
**graphic novel** — stunning art, told exactly the way you want — that you can order
in print, relive, and share. Publish a few sessions now, a few more later, and you've
built a whole **series of graphic novels** of your own campaign.

**Original-world protection:** Campaignia treats your campaign as your own original
fictional world. If names in your story happen to match canonical or copyrighted
material, Campaignia won't represent or pull from that material — it keeps your name
but creates a new, unique version for your story, never reproducing the original's
designs, likenesses, costumes, logos, or signature look.

---

## 2. Tiers

Campaignia has a Free Trial plus four standing tiers: Copper, Silver, Gold, Platinum.
(Copper and Free Trial are **not** the same thing — see below.)

- **Free Trial** — where new users start. Built to let you experience the full breadth
  of Campaignia: Platinum-level creative access (all art, narrative, and layout
  options), and you can create a campaign, characters, and sessions to see exactly how
  everything looks, backed by a generous starter batch of tokens. It runs ~30 days and
  is **limited in volume** (very few sessions/characters — enough to reach your first
  rendered session). Trial images are **watermarked**. When the trial ends, the account
  drops to Copper.
- **Copper** — a free account, no subscription. A Copper member can't create their own
  campaigns or sessions, but is a full member of campaigns run by subscribing Story
  Masters. Once the Story Master marks a session **Ready**, a Copper member can create
  their own version: they can't change the Story Master's story text, but they can add
  notes, steer Campaignia, create different moments, control how their characters look,
  regenerate images, and use the art styles available in that campaign. They can save
  to and reuse the Archive (their own and other members' images), and update the look of
  a character they play before sessions are readied. Copper can buy token packs to spend
  in a paid Story Master's campaign.
- **Silver** — 1 campaign, unlimited sessions, unlimited characters, monthly free
  tokens, a capped number of moments per session, and more art styles than the floor.
- **Gold** — 3 campaigns, unlimited sessions and characters, more free tokens than
  Silver, more moments per session, and more art *and* narrative style options.
- **Platinum** — unlimited campaigns/sessions/characters, the largest monthly token
  grant, the highest moment caps, all styling options, and the ability to build
  **custom art styles**.

**Creative access is inherited within a campaign.** The art/narrative/layout options a
member can use equal the **higher of their own tier and the Story Master's tier**.
That's why a Copper member in a Gold Story Master's campaign can use Gold-level art
styles — they inherit the campaign's creative level. (Inheritance raises the creative
toolset only, not account-level allowances: a Copper member under a Platinum Story
Master still can't create their *own* campaigns or sessions.)

**Moments per session** are capped by tier. The cap is a **ceiling, not a target** —
Campaignia pulls the strong, distinct beats from your story's content rather than
padding to hit a number, so a lighter session yields fewer moments. The exact per-tier
maximum lives on the dashboard and is looked up live.

---

## 3. Tokens

Image work is paid for with **tokens** — generating, regenerating, or retouching an
image currently costs tokens. There are two kinds:

- **Carry-over tokens** bank and roll from month to month — they **never expire**.
- **Use-it-or-lose-it tokens** are granted each billing cycle and must be spent before
  it ends, or they're gone.

When you spend, your **use-it-or-lose-it tokens go first**, which protects your banked
and purchased ones. **Purchased tokens are carry-over** — they never expire, so you can
stockpile for something big like a large end-of-campaign print run.

**What spends tokens:** generating, regenerating, or retouching an image, plus
analyzing or previewing a custom art style. **Free actions:** replacing a panel image
from the Archive, locking an image, and archiving an image. Generation is
**spend-on-success** — if an image fails, you are **not** charged.

**Generating a story or a narrative may also cost tokens**, depending on current
settings. When it does, the cost of *Generate Story* scales with how much text you
provide (your transcript, notes, and lore), and the cost of *Generate Narrative* scales
with how many panels it is writing for. Either can be set to cost nothing — and your
token balance updates right after you generate, so you can always see what an action
actually cost.

---

## 4. Billing & subscriptions

- **Starting paid billing:** when your trial ends or you subscribe, you add a credit
  card (processed by Stripe) that goes on file. That day sets your billing cycle —
  you're billed monthly on roughly the same date for your tier. Current pricing is on
  the Account page.
- **Upgrades & downgrades:** change tiers anytime; Stripe handles all proration.
- **Canceling:** cancel anytime and your subscription ends; you drop to the free Copper
  tier and your card isn't charged again. Your campaigns and data stay with your account.
  If a free account later goes inactive for a long time, the inactivity policy below
  applies -- but simply logging in keeps it active.
- **Manage on the Account page:** subscription changes, cancellation, and card updates
  all live there (a hosted Stripe Billing Portal).
- **Suspend vs. cancel:** suspending your account (Account page) is a one-click pause —
  it cancels your subscription, drops you to the free tier, and **keeps all your data**.
  Reactivate any time by simply logging back in. Canceling through the billing portal
  just ends the subscription (you stay on Copper, active).
- **Downgrading or lapsing to Copper doesn't lock or delete your campaigns.** You keep
  full editing of campaigns and sessions you own, and can keep generating while you have
  tokens. What changes: you can't create *new* campaigns or sessions, advanced styles
  revert to the base options.
- **Copper is the floor.** No monthly charge — you only pay when buying tokens. Follow
  along with your Story Master for free; to create your own images/version, buy tokens.
  Any Copper account can buy token packs at any time to spend on its own images.
- **Refunds:** all sales are final — no refunds, including on purchased tokens. If you
  think you were charged in error, contact support.

### Account inactivity & closure (what happens over time)

This applies ONLY to a free Copper account that is **not** covered by a paid Story
Master (not a player in any campaign whose Story Master is on a paid tier). Paid accounts
and covered members are never on this timeline.

The exact day counts are configurable and are given to you in the ACCOUNT LIFECYCLE
settings block provided with each question -- always quote those live numbers, never
guess. The stages, in order:

1. **Inactivity warning.** After the configured idle period with no logins or purchases,
   we email a heads-up that the account will be paused if it stays idle.
2. **Suspended.** If still idle after the configured grace period following that warning,
   the account is paused. Nothing is lost -- campaigns, characters, and books are kept.
   **Logging in reactivates it instantly.**
3. **Closure reminders.** While suspended, we email reminders at the configured lead
   times before the closing date, each naming the exact date.
4. **Closed.** If it stays suspended through the configured window, the account is closed.

**What resets the clock:** logging in -- or buying tokens or a print -- at any point
before closure restarts the timeline and clears any pending warning or suspension. Every
step before closure is undone simply by logging in; only closure itself is permanent.

When asked "will my account be deleted / what happens if I stop using it," walk through
this flow using the live numbers, and reassure that staying active keeps everything safe.

---

## 5. The Account page

- **Profile:** your name, email, and an optional **pen name** (your public author
  credit if you publish to the Library, and the "Chronicled-by" line in printed books;
  must be unique).
- **Change password:** current + new + confirm.
- **Notifications:** opt in/out of three email types — promotions, new-feature updates,
  and campaign activity (an email when someone joins one of your campaigns). Account,
  billing, and order emails are always sent.
- **Usage:** your current token balance and usage.
- **Plans:** your current plan, upgrade options, and Manage subscription & billing.
- **Account actions:** Sign out, or Suspend account.
- **Feedback** (from the profile menu): send a typed message — pick a type, optional
  subject, and your message; it reaches support, who can reply directly.
- **My Orders:** your past print orders, with details and tracking.

---

## 6. Getting your story out: Export, Print, Publish, Order

You spend tokens to generate images; once generated, they're yours. These four are
distinct:

- **Export** — save your book as a PDF via the PDF control (from **True View** /
  **Open in New Tab**).
- **Print** — print that PDF on your own printer, from the same control. No extra
  requirement beyond being able to Export.
- **Publish** — publish your finished story to the public **Library** as a shareable
  web page. You can only publish your *own* version; each Publish creates a new Library
  entry, managed on your Account page.
- **Order** — order a physical print-on-demand (POD) book through our print partner.

**True View** (the exact on-screen look of the finished book) is available to everyone
— including a lone Copper member — for a session or the whole novel. **Export and home
Print** are open to anyone who can view the story (the browser's PDF viewer does the
save/print). The two things that require an **effective paid tier** (your own
subscription, or a Copper seat under a paid Story Master) are **Publishing to the
Library** and **Ordering a POD book** (the clean, bound version).

**Watermark:** only **Free Trial** images carry a Campaignia watermark — nobody paid for
those. Copper and all paid tiers get clean, unwatermarked output. (Because the trial
lapses to Copper, a trial that does nothing will later lose the watermark — that's fine,
since it also loses everything else the trial offered.)

---

## 7. Outfitting a group / table

If you run a table, you subscribe to a paid tier and your players join **free as Copper
members**. They inherit your tier's styling inside your campaign, can build their own
version of the campaign, and only need to spend tokens to generate their *own* images —
which they can buy as packs while they're in your (paid) campaign. So one paid Story
Master can outfit a whole group; players pay nothing unless they want their own art.

---

## 8. Campaigns

A **campaign** is your story — the world everything lives inside. It can hold one
session or a hundred; there's no cap. Create one from the home screen (New Campaign →
name + description). A campaign is built from:

- **Sessions** — the heart of it; each is a piece of your story (a chapter, or a
  night's game session).
- **Characters** — your cast, with reference images for consistency. **Strongly
  recommended to set up first**, before generating stories, so Campaignia recognizes
  who's who in your transcript. (Not strictly required.)
- **Members** — people you invite; they can follow along or build their own versions.
- **Assets** — reference images of items, locations, or recurring figures to keep
  consistent.
- **Archives** — saved images to reuse later.
- **Publish** — where you publish to the Library and order printed copies.

**Campaign details (the tile's Details button — Story Master only):**
- **Members' publishing & ordering access** — control whether members can publish and
  order books on their own, or whether you keep that in your hands (e.g. to produce and
  charge for copies yourself).
- **Allow members to add assets** — decide whether members can add their own assets.
  (Asset count limits still apply either way.)
- **Campaign image** — pick an Archive image for the campaign tile; it also becomes the
  **default book cover** when publishing unless you choose another.
- **Lore / Background** — describe the world your campaign takes place in: its
  backstory, key locations, factions, history, and tone (up to 6,000 characters).
  Every session draws on this when its story and image prompts are generated, keeping
  the whole campaign consistent and connected across sessions. Also editable from the
  pencil edit on the campaign page.
- **Delete campaign** — only when the campaign is completely empty: no sessions,
  characters, assets, archived images, or other members.

---

## 9. Characters

Open **Characters** inside a campaign to build your cast. The Story Master can
create/edit any character; a member assigned a character can create/edit *that* one,
including its reference images.

**The card:**
- **Character name** — what the AI matches into panels; add alternates/nicknames after
  a slash (e.g. "Theron Ashwood / Ash").
- **Player name** — the real person playing/managing the character; helps map a
  transcript to the right character.
- **NPC** *(Story Master only)* — flag a *recurring, important* non-player character (a
  major villain, key ally). Minor or one-off NPCs go in the **Asset Library** instead.
- **Race and class** — one optional field (e.g. "Half-elf Ranger").
- **Visual & Personality Traits** — describe look *and* personality in detail.
  Appearance feeds the image; **personality strongly shapes the narrative**.
- **Reference images** — four slots (Portrait, Full Body, Action Shot, Other). More
  references = better consistency. Hero Forge shots, fan art, and miniature photos all
  work. Upload only images you own or have rights to.

**Building it:** fill in the card and click **Create character**; Campaignia builds the
Character Prompt and canonical reference image from your info and images. Edit the
prompt, and regenerate / retouch / replace / archive the image as needed; click
**Done** to save. The reference is kept **style-neutral on purpose** so the character
looks right in any art style — art styles apply when generating story moments, not to
the reference itself.

---

## 10. Sessions

Sessions live inside a campaign and are where the story actually happens. Each session
has tabs: **Story**, **Characters**, **Review**, **Storyboard**, and **Preview**.

### 10.1 Story tab
Two big text areas side by side:
- **Story / Session Transcript** — paste or type the raw material of your story (a
  game-night transcript, notes, journal entries — anything). **This field belongs to the
  Story Master** — only they can edit it; members can read but not change it. (Paste only
  content you own or have rights to.)
- **Story Notes and Instructions** — director's notes to Campaignia: mandatory scenes,
  atmosphere, character directions ("always show Theron with his wolf"). The AI follows
  these precisely. Members **can** edit their own notes here.

**Find / Replace** sits above the transcript (Find next / Replace / Replace all) — handy
for fixing a wrong name everywhere at once.

**Generate Story** reads the transcript *and* the notes, picks the key moments worth
illustrating, and produces a **story outline** (reviewed on the Review tab before any
images are made). It also:
- **Builds the session's cast** — detects which campaign characters appear in *this*
  story (by name) and adds just that subset to the Characters tab.
- **Rebuilds from scratch** — it deletes the current moments on that version (images and
  narrative) and regenerates fresh; it warns you first. **Locks block it:** if the
  version has any locked panel, a locked title image, or an approved character change
  pinned to a panel, Generate Story refuses and asks you to unlock/clear those first.

The **Story Master runs Generate Story first**, which establishes the session. After
that, **any member can click Generate Story on their own version** to re-extract their
own outline from their own notes. (Transcript and notes save automatically on click.)

### 10.2 Characters tab
Lists the characters detected in this session. It also:
- **Detects visual changes** — if the story describes a change (a horn breaks off, a
  sunburn, a hole in a hat), Campaignia flags the character with a **review badge**.
  Open it with the character's **Edit** button.
- **Amend the look** — edit the description and type what changed into the **Amended
  appearance** box, then **Retouch image**: it applies just that change to the current
  reference and shows the result. **Approve change** to keep it, or **Discard / Ignore**.
- **Pin to a moment** — a "Change first appears at this Moment Panel" dropdown sets when
  the new look kicks in (normal before, changed from it onward). Leave Empty to apply
  throughout.
- **Evolves across sessions** — each session pulls every character forward from where
  they ended the previous session, so a character visibly evolves over time. Approving a
  change carries it into later sessions.
- **Going back** — use **Replace from Archive** to restore an earlier look.

### 10.3 Review tab
See how Campaignia planned your story **before** it writes the full narrative or spends
tokens on images. Every **image panel** and every **bridge** between panels shows an
**outline** — the facts and sequence the narration will cover — so you can catch
anything missing or wrong first. Per panel you can:
- **Edit Narrative Outline** — the **facts** you want covered (the *what*). Your edits
  persist and steer the prose on every regenerate.
- **Edit Narrative Direction** — **how you want it written**: tone, emphasis, pacing
  (the *how*). Optional flavor on top.
- **Edit Image Prompt** — the wording that drives the **picture** for that panel
  (image panels only).
- **Add/remove characters** and **add/remove assets**, and see where a **character change**
  lands. A **cast badge** shows **Auto-Matched** (automatic name-matching) or **Custom
  cast** once you change it; **Reset to auto** reverts.
- On a **phone**, a panel's actions collapse into a **⋯ menu**.

Outline = the facts; Direction = the flavor — they work together and don't conflict.

**You cannot reorder the panels.** The panel order follows your story's chronology. If your story came out in the wrong order, the best fix is to correct the **Story / Transcript** field directly. If that isn't possible, add explicit notes in the **Story Notes / Instructions** field spelling out the correct order of events, then **Generate Story** again from scratch.

Pick your styles up top **first**: the **Narrative style** and **Art style** buttons
(they show the current pick; which styles you can choose depends on your tier). Then
**Generate Narrative & Images** turns the outline into the finished story — it writes the
prose, renders the panels, and spends tokens.

### 10.4 Storyboard
Where the story comes together as alternating image panels and narrative.
- **The title panel (first)** — a wide establishing shot of the setting, meant to draw
  you in like a film's opening shot, with its own opening narrative. Editable afterward.
- **Each image panel** has: **Edit prompt** (then Regenerate), **Regenerate**,
  **Retouch** (change one small detail), **Revert** (appears after a Retouch/Regenerate;
  undoes that last change — one step deep, hidden once locked), **Replace** (from the
  Archive), **Lock** (protects it from a global Generate Images), and **Archive** (saves
  a copy).
- **The panel's ⋯ (moment options)** — the same casting controls as Review (add/remove
  characters/assets, then Regenerate), plus a **Prominence** dropdown that controls size
  at publish/print: set it **high** to make that image as large as possible in the book.
- **Narrative panels** sit **below and between** the images. Edit the narrative prompt
  and Regenerate, or click into the text and type changes directly.
- **Top of the Storyboard:** change **Narrative style** or **Art style**, then
  **Generate Narrative** (rewrites prose across all panels) or **Generate Images**
  (re-renders every image that isn't locked).
- The **Auto-matched / Custom cast** badge and **Reset to auto** appear here too.

### 10.5 Preview tab
See how it looks on the printed page.
- **Layout** — Comic, Picture Book, Magazine, or Gazette (the button shows the pick).
- **Quick View / True View** — Quick View is a fast on-screen look; **True View** is
  exactly how it'll print, with page breaks, gutters, and margins.
- **Open in New Tab** — full-size PDF in the browser (save/print via the browser).
- **All publishing options →** — (with access) jumps to the Publish page.

### 10.6 The session top bar
- **Draft / Ready** — the Story Master sets this; members see a read-only status. In
  Draft, no other member can see the session. In Ready, members can see it and make their
  own version. Once *any* session in the campaign is Ready, members can no longer edit the
  canonical characters — they edit characters inside their own version. Switching back to
  Draft anytime is fine and loses no data.
- **Assets** and **Archives** — campaign libraries.
- **Version dropdown** — defaults to your own version; switch to view another member's.
- **Make my own version** — appears for a member once the Story Master marks the session
  Ready; clicking it drops you onto your own version with Generate Story and every control
  above.

---

## 11. Versions — your own edition of the book

A **version** is your own edition of a campaign's book. It holds a complete set of
choices — the cover, the title, the layout, the art style, the narrative style — plus your
own copy of the narrative and the pictures for any session you've branched. Two people can
read the same campaign and build completely different books from it, and neither can change
the other's. A version belongs to one person, spans the whole campaign, and stays exactly as
you left it when you come back.

Think of it as a **printing of a book**, not a draft of one. Versions sit beside each other
rather than in a line — yours isn't a newer edition of the Story Master's, it's a different
one.

**What a version holds**

- **The cover and title block** — book title, subtitle, title colour, title style,
  placement and size, plus the cover, back cover and title-page images.
- **The layout** — layout style, picture borders and frames, caption style, body font, drop
  cap, running page header, session dividers and whether each session starts on a fresh
  page, and whether to include the cover page, the character page and the contents.
- **The styles** — art style, narrative style, narrative verbosity.
- **The content of every session you've branched** — the panels and their pictures, prompts,
  order and locks; the narrative intro, sections and outro; the Direction notes and
  outlines; the per-session character looks; and which sessions are in the book at all.

**What a version doesn't hold**

- **Sessions you haven't branched.** A version only holds its own copy of a session once you
  make one there. Everywhere else it reads the Story Master's canonical session — which is
  what makes a version cheap: branch the one session you want to change, and the rest of the
  book is still the Story Master's.
- **The campaign itself** — characters, assets, the transcript, the campaign name and image
  belong to the campaign, not to any version.
- **The campaign's name.** Your book title *starts* as the campaign name, but once the
  version exists they're separate things. Renaming the campaign later does **not** rename
  your book.

**The canonical version**

Every campaign has one **canonical** version. It's the Story Master's, it's created
automatically the first time any session is worked on, and it's what everyone else's version
reads through for sessions they haven't branched themselves. It belongs to whoever currently
holds the Story Master role, so it follows a handover.

**Making a version**

**Your first version of a campaign is free. Making another one needs Gold or higher on your
own paid plan** — a Story Master's plan doesn't extend this one, and the Free Trial doesn't
include it. A trial account gets one version, and keeps every art style.

- **You always make a version from a session, never from nothing.** Branch a session and the
  version comes into being around it. The buttons are **Make My Version** (your first one on
  a session) and **New Version** (once you already have one there).
- **You copy whichever version is on screen**, whoever owns it — the canonical usually, or
  your own if you want to try a second idea without losing the first.
- **The session has to be Ready.** The Story Master publishes a session before anyone else
  can branch it.
- **You must name it, every time.** A version appears on every session in the campaign, so
  the name is the only thing telling you which book you're looking at. Names must be unique
  among your own versions of that campaign.
- **Adding a session to a version you already own is always free** — that isn't a new
  version, it's an existing one picking up another session.

Branching copies the panels and their pictures, the narrative and its summaries, the
Direction notes, the outlines, the per-session character looks, the casting, and the art and
narrative styles. One deliberate exception: when you add a *second* session to a version you
already have, the content comes from the session you branched but the **style comes from
your version** — otherwise your book would render half in one art style and half in another.

**Who can change what**

**You can look at anyone's version. You can only change your own.** Opening someone else's
shows you their book, their cover and their layout exactly as they have it; nothing you do
while looking at it is saved to their version, and Campaignia tells you rather than failing
quietly. **The Story Master isn't an exception** — if a Story Master wants a member to have a
differently-styled book, the answer is to make a version for them, which carries the layout,
the art style and the narrative too.

**What's saved, and when**

**Everything on the Preview & Export tab saves automatically** — there's no Save button for
cover and layout settings. Change the title and click away; pick a border; choose a colour;
each is written to your version as you make it. The first time you open Preview & Export on a
version, its settings are written in as they stand, so the version genuinely owns them and
the book you branched from can be restyled later without yours changing underneath you. The
title and settings then follow the book everywhere — the Optimize tab renders with them, the
Order and Publish tab shows them, and they're still there when you come back tomorrow.

**Subtitles are optional and empty by default.** Leave the field blank and nothing prints
under the title; if you want the session dates there, type them.

**Building, publishing and printing a version**

- **The book you build is the version selected in the picker** — preview, Optimize, save,
  publish, print and order all carry that selection, so you can't optimize one version and
  publish another by accident.
- **Optimize saves per version and per layout style**, so optimizing in Magazine doesn't
  disturb the Picture Book layout you approved last week, or anyone else's book.
- **Publishing takes a snapshot** — a published story is a copy of the exact file you
  approved, with its own Library record. Change your cover afterwards and the published book
  keeps the one it went out with.
- **That's how you publish a series.** Publish the first few sessions as Episode One, then
  change the cover and subtitle, include the next few sessions and publish Episode Two — from
  the *same* version, so the font, frames and layout stay consistent across the run while the
  cover and subtitle change per issue. Episode One in the Library is untouched.
- **Renaming and deleting act on the version you're looking at**, never on another. Deleting
  is done a session at a time.

---

## 12. Assets (the Asset Library)

Assets keep your story consistent across sessions. An asset is a reference image — of a
**location**, a **recurring minor character (NPC)**, or an **item** — that Campaignia
pulls into panels when relevant (e.g. an item like a magic sword, a location like a
specific tavern, or a minor recurring NPC like the tavern barkeep).

- **Three categories — Location, NPC, Item** — tag each asset.
- **Locations are special:** a Location asset becomes the **background** your characters
  are set against in the moment images.
- **Matched by name:** give an asset multiple names/keywords separated by a slash, and
  it'll match any of them.

**Adding an asset:** open the Asset Library, click **Add asset**, give it a name (or
several, slash-separated) and a category, then either **write a description and generate**
a reference image, or **upload** your own. The description stays editable, and once an
image exists you can **Regenerate** it (a fresh take from the description), **Retouch** it
(change one thing), **Revert** the last change, or **Replace** it with an image from your
**Archive**. There's no separate save step — the asset is created the moment you generate
or upload, and edits save as you go.

**Asset vs. character:** a *minor or one-off* recurring figure (the tavern barkeep)
belongs here as an NPC asset; a *major, important* recurring character (a main villain,
a key ally) belongs on the **Characters tab** with the NPC flag.

---

## 13. Archives

The Archive is a campaign-wide gallery of every image you've saved off — from the
storyboard or from character creation. See each image full-size with details, and
**filter** by session, version, moment, character, creator (which member made it), type
(character vs. moment image), and art style, plus sort. Here you can:

- **Make an image Public** — a checkbox on each image shows it in Campaignia's public
  Library, credited to your **pen name** (without one, it shows with no name). A way to
  show off a single great image. Only the person who archived the image — or the campaign's
  Story Master — can toggle it public.
- **Reuse and share** — archived images are what you pull back into a story (via Replace
  from Archive), and they're shared across members: a great image you made can be pulled
  into another member's version.

**Asset & Archive limits:** both the Asset Library and the Archive have a per-campaign
limit that scales with tier (higher tiers allow more); the live number comes from the
dashboard.

---

## 14. Members

The Members screen (inside a campaign) is where you invite people and manage who's in
it. Every campaign has exactly one **Story Master**.

- **Invite a member** — click **Invite member**, enter their email, and use the "Check to
  assign a character to this Member" checkbox to decide whether they get a character. If
  they'll play a character you haven't created yet, you can create it for them with just a
  name. Click **Send Invite**.
- **Share the invite** — the invitee gets an email, and you can also **Copy link** to send
  it any way you like (Discord, text, etc.).
- **Manage invites & members** — on the grid's ⋯ menu, **Revoke** a pending invite, or on
  a member choose **Make Story Master** to hand the campaign over.
- **Handing off the Story Master role** — every campaign needs a Story Master, so if your
  subscription lapses or you stop running the story, hand control to another member with
  **Make Story Master**. The incoming Story Master needs a paid subscription. Handoff
  preserves everyone's own versions, and the outgoing Story Master stays on as a regular
  member.

---

## 15. Publish

Turn finished sessions into a graphic novel — published to the Library and/or ordered as
a printed book. Three parts:

**1. Choosing what goes in (Publish/Sessions tab)**
- **Version dropdown** ("Generating novel for…") — defaults to your own version; switch
  to publish another member's.
- **Session cards** — every session in the campaign appears, each with its title image,
  Ready/Draft status, and an **open** link. A card uses **your own version** if you've
  made one; for any session you **haven't versioned**, it falls back to the **Story
  Master's canonical version**. So a card can read Draft, and some may be the SM's version
  — check both before publishing.
- **Include in Print checkbox** — tick which sessions go in. Leave all checked to compile
  the whole story, or pick a subset for episodes/smaller volumes.

**2. Preview & Export — "Prepare to Publish" panel**
- **Title** — defaults to the campaign name; change it here.
- **Title color** — color of the title text so it stands out against the cover.
- **Cover, Back & Title images** — pick each from your Archive.
- **Refresh preview** — re-render the right-hand preview.
- **Blurb** (optional) — Library-page teaser; leave blank and it uses your opening
  narrative.
- **Rights checkbox** — confirm you own/have rights and the content is general-audience.
  Required to publish.
- **Publish to Library** — makes your story a public web page anyone can read.
- The preview side mirrors the session Preview tab: Layout, Quick/True View, navigation,
  and Open in New Tab.

**3. Order a printed copy (Order tab)**
- The book **title** carries from the preview; add an **order name** to label it. Shows
  which version and who owns it.
- Print options: **binding** (softcover, hardcover, comic), **color** (premium
  recommended), **cover finish**, **shipping speed**, plus your shipping address.
- **Get price** quotes the cost from your options and the page count.
- **Prepare Your Order** generates the final interior + cover PDFs to review; you must
  tick **"I have reviewed both the interior and cover PDFs"** before continuing.
- **Continue to secure payment** → Stripe checkout (add a card if none on file) and
  places the order. **All print orders are final — no refunds, and an order can't be
  pulled back once placed.**
- You get a **tracking number**, and past orders (with tracking + details) live under
  **My Orders**.

---

## 16. The public Library

The Library is where you browse everything the Campaignia community has made public. Two
sides: a gallery of **public images** (single images users flagged public, credited to
their pen names) and a **Stories** directory of **published graphic novels**. Search by
**author / pen name**, then open a story to **read** it on its page or **download** it.
It's also where your own published stories and public images appear to the world.

---

## 17. Custom Art Styles (Platinum)

On the **Platinum** tier you can build your own art styles, under **Custom Art Styles**
in the profile menu. Click **New style**, name it, and upload **2–4 reference images that
share the look you want** (style, not subject). Hit **Analyze**: Campaignia studies the
*artistic qualities* — line structure, color, shading, shadowing, blending — **not the
content** — and builds an art-style prompt from them. **Preview render** shows the
result; if it's off, edit the prompt and preview again until you're happy. Your style
then appears under the **Art style** button on the Review, Storyboard, and Preview
screens for use on your story moments.

Notes: creating a style requires a **true Platinum subscription** (inheriting Platinum
from a Story Master lets you *use* styles, not *build* them). **Analyze and Preview each
cost a token.** If you later drop from Platinum, your existing styles stay usable — you
just can't make new ones.

---

## 17a. The Title Builder (Platinum)

On the **Platinum** tier you can have your book or chapter title **drawn as artwork**
instead of set in type. You can access the Title Builder under the title section of the
**Prep & Preview** tab on the Publish page, or on the **Opening Panel** on the
**Storyboard** and **Review** tabs on the Session page.

Your title and subtitle come from the book — the drawing uses **those exact words**, so
change them on the prior screen if they aren't right. Then describe **how the lettering
should look** — emeralds embedded in decorative iron, gold and black ribbons, carved in
stone. That description is what decides the style. You can also drop in a **reference
image** whose writing style or drawing you want the lettering to mimic.

**Generating it** costs a token. Unlike your panel images, a title is drawn with a
**transparent background**, so it sits on the cover or that chapter heading in your book
without covering it and without other decorations or borders.

Once it's drawn you can **Retouch** it — describe one change, another token — or
**Archive** it so you can put it back later with **Replace from Archive**, which costs
nothing. **Done & Use** puts it on the cover; **Done & Stash** keeps the drawing but takes
it off, and on a chapter puts the panel's picture back. Nothing reaches your book until
you press Done & Use.

Notes: the Title Builder needs a **true Platinum subscription**. **The five typed title
styles are on every plan** — this is the drawn alternative to them.

---
## 18. Tokens at the top + buying bundles

- **Token count (top bar):** the gem icon and number in the header is your current total
  token balance — your monthly use-it-or-lose-it tokens plus your carry-over tokens. Click
  it (or **Buy Tokens** in the profile menu) to open the Buy Tokens window and top up.
- **Buying tokens (bundles):** tokens come in packs of increasing size, and **bigger
  packs give more tokens for your money**. **Purchased tokens are carry-over — they never
  expire.** You can buy packs if you're on a paid plan, or if you're a member of a campaign
  run by a paid Story Master. The Buy Tokens window shows the current pack sizes and prices.

---

## 19. Common goals — how to do it

Task-oriented answers. Match the user's goal to one of these and give the concrete steps.

- **"I want the art to look a certain way" (a painter, a medium, an aesthetic — e.g.
  "like Van Gogh," "watercolor," "noir comic").** Set it with the **Art style** button on
  the Review, Storyboard, or Preview screen — pick the closest preset (the live
  styles-by-tier block lists exactly which presets you have). For a specific look, the
  painterly presets are usually closest. **If you're on Platinum, the best route is the
  Custom Art Style Builder** (profile menu → Custom Art Styles): upload 2–4 reference
  images in that look, click **Analyze**, and Campaignia builds a matching style you can
  use on your moments. Campaignia makes *original* art inspired by an aesthetic
  (post-impressionist, watercolor, cel-shaded), so a "Van Gogh feel" is fine — it just
  won't clone a specific copyrighted artwork.
- **"My character looks wrong / keeps changing between panels."** Open the **Characters**
  tab → the character's **Edit**. Tighten the description and add more **reference
  images** (more references = better consistency). If the *story* changes their look,
  type it into **Amended appearance** → **Retouch image** → **Approve change**, and use
  the "Change first appears at this Moment Panel" dropdown to set when it kicks in. To go
  back to an earlier look, use **Replace from Archive**.
- **"I want more / fewer panels in a session."** Moments are pulled from your story's
  content up to your tier's ceiling — Campaignia won't pad to hit a number. For **fewer**,
  trim or tighten the transcript/notes; for **more**, add detail and distinct beats (and
  a higher tier raises the ceiling). Then re-run **Generate Story**.
- **"I need to fix a wrong name or detail everywhere."** Use **Find / Replace** above the
  transcript on the **Story** tab for names. For narrative wording, edit the narrative
  panel text directly (or its prompt and Regenerate). Only re-run **Generate Story** if
  you want a full rebuild — it wipes and regenerates the current moments.
- **"How do I change the tone / wording of the story?"** Use the **Narrative style**
  button for the overall voice, **✎ Direction** on a panel to steer one beat, or click
  into any narrative panel and edit the text. **Generate Narrative** rewrites all prose.
- **"How do I steer one specific panel?"** On Review or Storyboard, use that panel's
  **✎ Direction** (it steers both the prose and the image), **Edit prompt**, or the
  **⋯** menu to add/remove characters/assets — then **Regenerate**.
- **"How do I make one image bigger in the printed book?"** On the Storyboard, open that
  panel's **⋯** menu → **Prominence** → set it high.
- **"How do I share my story or show it off?"** Publish the whole novel to the public
  **Library** (Publish page → Prepare to Publish → Publish to Library) for a shareable web
  page, or flag a **single image Public** in the Archive. For personal use, **Export**/
  print the PDF; for a physical book, **Order**.
- **"How do I get a printed copy?"** Publish page → **Order** tab: choose binding, color,
  finish, shipping; **Get price**; **Prepare Your Order**; review both PDFs; pay via
  Stripe. (Requires an effective paid tier.)
- **"I'm out of tokens / I need more."** Click the **token count** (top bar) or
  **Buy Tokens** in the profile menu. Bigger packs give better value, and **purchased
  tokens never expire**. (Copper can buy only while in a paid Story Master's campaign.)
- **"How do I add my players?"** **Members** screen → **Invite member**: enter their
  email, optionally assign a character, then **Send Invite** or **Copy link**. They join
  free as **Copper** members.
- **"How do I keep a place, item, or minor NPC consistent?"** Add it to the **Asset
  Library**: a **Location** asset becomes the panel background; **Item** and minor **NPC**
  assets get pulled in by name (use slash-separated keywords to match variants). Major
  recurring characters go on the **Characters** tab instead.
- **"Where do I start / what's the right order?"** Create a campaign → add **Characters**
  first (recommended) → create a **Session** → paste the transcript and notes →
  **Generate Story** → review on the **Review** tab → **Generate Narrative & Images** →
  fine-tune the **Storyboard** → check **Preview** → **Publish** or **Order**.
- **"How do I change the book's layout?"** **Preview** tab → **Layout** button: Comic,
  Picture Book, Magazine, or Gazette. Use **True View** to see the real printed result.
- **"How do I hand off running the campaign?"** **Members** → the member's **⋯** →
  **Make Story Master**. The incoming Story Master needs a paid subscription; everyone
  keeps their own versions.
- **"How do I undo an image change, or protect a good one?"** **Revert** on the panel
  undoes the last retouch/regenerate (one step deep; hidden once locked). **Lock**
  protects an image from a global Generate Images and from a Generate Story rebuild.
  **Replace from Archive** swaps in an earlier saved version.
- **"How do I set up my cover and title?"** Publish page → **Prepare to Publish**: set
  the **Title**, **Title color**, and pick **Cover / Back / Title** images from your
  Archive; add a blurb if you want.
- **"Can I use an image another member made?"** Yes — the Archive is shared across the
  campaign, so **Replace from Archive** can pull another member's image into your version.
- **"Can I publish just part of my campaign?"** Yes — on the Publish page tick only the
  sessions you want under **Include in Print** (good for episodes or smaller volumes).

---

## 20. Why can't I… / troubleshooting

Friction points and what's actually going on.

- **"Why can't I create a campaign or session?"** You're on **Copper** (or your trial
  ended / you downgraded). Copper can join and build one version of its own inside a paid
  Story Master's campaign, but can't create its own campaigns or sessions. Subscribe to
  create.
- **"Why is there a watermark on my images?"** Only **Free Trial** images are
  watermarked. On any paid tier — or as a Copper member under a paid Story Master — your
  images are clean.
- **"Where did my tokens go / why did my balance drop?"** Your **use-it-or-lose-it**
  tokens are spent first and expire each billing cycle; **purchased / carry-over** tokens
  never expire. Generating, regenerating, and retouching images cost tokens; replacing
  from the Archive, locking, and archiving are free; and **failed images aren't charged**.
- **"Why can't I edit the story text?"** The **transcript belongs to the Story Master** —
  members can edit their own **Notes** and their own **version**, but not the canonical
  transcript. Also, once any session is marked **Ready**, members edit characters inside
  their own version rather than the canonical ones.
- **"Why can't my player see the session?"** It's still in **Draft**. Mark it **Ready**
  and they can see it and make their own version.
- **"Why can't I delete my campaign?"** Delete only works when the campaign is completely
  **empty** — no sessions, characters, assets, archived images, or other members.
- **"Why did my styles change after downgrading?"** Advanced styles revert to the base
  options on lower tiers. Your existing content isn't locked or deleted — you keep
  editing what you own as long as you have tokens.
- **"Why can't I buy tokens?"** Copper can buy tokens only while part of a **paid Story
  Master's** campaign. Otherwise, subscribe to a paid tier.
- **"Why can't I build a custom art style?"** It requires a **true Platinum
  subscription**. Inheriting Platinum from your Story Master lets you *use* styles, not
  *build* them.
- **"Why are some panels skipped when I hit Generate Images?"** **Locked** panels are
  skipped on purpose. Unlock them to include them.
- **"Why won't Generate Story run?"** It rebuilds from scratch and refuses to wipe
  **locked** panels, a **locked title image**, or an **approved character change pinned to
  a panel** — unlock or clear those first.
- **"Why is the wrong character (or no character) in a panel?"** Casting is **auto-matched
  by name**. Fix it via the panel's **⋯** menu (add/remove characters) or **Reset to
  auto**, and check the character's name and slash-separated alternates.
- **"Why can't I publish or order?"** Those require an **effective paid tier** (your own
  subscription, or a Copper seat under a paid Story Master). **True View**, **Export**,
  and home **Print** are open to anyone who can view the story.
- **"Why is my book showing the Story Master's version instead of mine?"** For sessions
  you haven't made your **own version** of, Publish falls back to the SM's canonical
  version. Make your own version of those sessions to use yours.
- **"My image failed to generate."** You weren't charged — just **Regenerate**. If it
  keeps failing, simplify the prompt or check your connection.

---

## 21. Quick FAQ

- **Do tokens expire?** Your monthly use-it-or-lose-it tokens do (each cycle); purchased
  and carry-over tokens don't.
- **Can I cancel anytime?** Yes — you drop to Copper and keep your data (held ~6 months if
  you suspend, then it may be removed with email warnings).
- **Are there refunds?** No — all sales are final, including token purchases and print
  orders.
- **Can my players use Campaignia for free?** Yes — they join as **Copper** in your paid
  campaign and only spend tokens for their own images (which they can buy as packs).
- **Does it copy copyrighted characters?** No. It keeps your names but creates original
  versions; it won't reproduce protected designs, likenesses, or signature looks.
- **What's the difference between Export, Publish, and Order?** **Export** = a PDF you save
  or print yourself; **Publish** = a public web page in the Library; **Order** = a physical
  printed book through the print partner.
- **What's "Story Master"?** The campaign's owner/runner — the equivalent of the DM. Each
  campaign has exactly one.
- **What's the difference between an asset and a character?** A **character** is a major
  recurring cast member (Characters tab); an **asset** is a **location** (which becomes
  the background), an **item**, or a **minor NPC** (Asset Library).
- **How do I see the real printed look?** **Preview** tab → **True View**.
- **Who can make an image public?** The person who archived it, or the campaign's Story
  Master.
- **Can I build a series?** Yes — publish some sessions now and more later; each Publish
  creates a Library entry, and you can compile subsets into separate volumes.

---

*End of the Campaignia Brain.*
