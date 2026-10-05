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

Then open **Admin** in the menu to add your staff:

1. Enter their name and email, then type a password or press **Generate**.
2. Choose the role (**Staff** or **Admin**) → **Add user**.
3. Give them the email and password shown. They sign in on their own phone or computer.

| What they can do                           | Admin | Staff |
|--------------------------------------------|:-----:|:-----:|
| View dashboard & reports                   |   ✔   |   ✔   |
| Record & update days                       |   ✔   |   ✔   |
| Delete days                                |   ✔   |   —   |
| Change shop settings & restore backups     |   ✔   |   —   |
| Add, edit & delete users                   |   ✔   |   —   |

**Deleting a user** signs them out and blocks them straight away. They appear under
**Removed users**, where **Restore access** lets them back in. To also erase their login
completely, delete them in Firebase console → Authentication → Users.

**Forgotten password:** press **Reset password** next to the user on the Admin page, or the user
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

## Good to know

- **Works offline.** If the network goes off, keep recording. Changes upload when the internet
  comes back (watch the status dot in Settings and the sidebar).
- **Who saved what.** Each day remembers which account saved it last ("last saved by …").
- **Backups.** Settings → Download backup gives you a file copy of everything.
