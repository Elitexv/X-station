# X-Station — Firebase setup

The site stores the shop's records in Firebase. The **admin** creates logins for the people who
use the app. There is no public sign-up. Do the steps below once, in the Firebase console:
https://console.firebase.google.com/project/x-station-c1a03

## 1. Turn on sign-in (Authentication)

1. Left menu → **Build → Authentication** → **Get started**.
2. **Sign-in method** tab → **Email/Password** → switch on **Enable** → **Save**.

> Leave **Settings → User actions → "Enable create (sign-up)"** switched **on**. The admin page
> needs it to create accounts. Strangers still can't get in: the security rules only let people
> the admin has added see or change anything.

## 2. Create the database (Firestore)

1. Left menu → **Build → Firestore Database** → **Create database**.
2. Choose a location (for example `europe-west`) → **Next**.
3. Choose **Start in production mode** → **Create**.

## 3. Add the security rules (important)

The rules decide who can do what (see the table below).

1. In Firestore Database, open the **Rules** tab.
2. Delete everything there, paste in the whole content of the `firestore.rules` file → **Publish**.

Paste the rules again whenever `firestore.rules` changes (or use `firebase deploy`, see step 6).

## 4. Run the site on your computer

Double-click **`start.bat`**. It opens http://localhost:8080. Keep the black window open while you
use the site.

## 5. Create the admin account (first time only)

The first time the site opens, the login page says **First-time setup**. Enter your name, email
and a password → **Create admin account**. This account becomes the admin, and the setup page
never appears again.

### Businesses

X-Station can manage several businesses: a charging centre, a shop, a restaurant, and so on.
Each one has its own records, dashboard, reports, currency and monthly target.

- **Add a business:** go to **Businesses** → **+ Add business**. Choose the type and it fills in
  income categories (for example *Food* and *Drinks* for a restaurant). Rename them or add more,
  up to 6.
- **Switch business:** use the **Business** menu at the top of the sidebar (on a phone, it's at
  the top of the screen). Dashboard, Record and Reports always show the selected business.
- **Edit or archive:** press ✎ on a business card. Archiving hides a business but keeps its
  records. Restore it, or delete it forever, under **Archived businesses**.

### Users

Open **Users** in the menu to add your staff:

1. Enter their name and email, then type a password or press **Generate**.
2. Choose the role. For **Staff**, tick the businesses they work on → **Add user**.
3. Give them the email and password shown. They sign in on their own phone or computer.
4. Change which businesses someone can use later with **Access** next to their name.

| What they can do                           | Admin | Staff   |
|--------------------------------------------|:-----:|:-------:|
| Which businesses                           |  All  | Chosen  |
| View dashboard & reports                   |   ✔   |   ✔     |
| Record & update days                       |   ✔   |   ✔     |
| Delete days                                |   ✔   |   —     |
| Add, edit & archive businesses             |   ✔   |   —     |
| Add, edit & delete users                   |   ✔   |   —     |

**Deleting a user** signs them out and blocks them straight away. They appear under
**Removed users**, where **Restore access** lets them back in. To also erase their login
completely, delete them in Firebase console → Authentication → Users.

**Forgotten password:** press **Reset password** next to the user on the Users page, or the user
presses **Forgot password?** on the login page. Firebase emails them a reset link.

## 6. Put it online, to use on phones (Firebase Hosting)

Run these once in a terminal in this folder:

```
npm install -g firebase-tools
firebase login
firebase deploy
```

This uploads the site and the security rules, then prints your link, for example
**https://x-station-c1a03.web.app**. Run `firebase deploy` again whenever the files change.

## 7. Install it as an app

X-Station is a progressive web app: it can be installed with its own icon and opens full
screen, like an app from the store.

- **Android / Chrome / Edge:** open the site and press **Install app** (in the sidebar, or
  Settings → App), or use the browser menu → **Install app** / **Add to Home screen**.
- **iPhone / iPad:** open the site in Safari → **Share** → **Add to Home Screen**.

Long-press the installed icon for shortcuts: **Record today**, **Dashboard**, **All businesses**.
When a new version is deployed, the app shows **"A new version is ready — Update now"**.

## Testing changes safely (optional)

To try changes without touching real data, run the local Firebase emulators (they need Java):
`firebase emulators:start --only auth,firestore`, then open http://localhost:8080/?emulator=1.

## Good to know

- **Works offline.** If the network goes off, keep recording. Changes upload when the internet
  comes back (watch the status dot in Settings and the sidebar).
- **Who saved what.** Each day remembers which account saved it last ("last saved by …").
- **Backups.** Settings → Download backup gives you a file copy of everything.
