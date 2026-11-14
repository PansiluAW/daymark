# Daymark

Daymark is an installable gym and nutrition habit tracker for individuals and private friend circles. Tap the habits you did today, then lock your check-in to color a tile. Log both habits on the same day for a **Double mark**.

## Open it on this computer

From this folder, run `npm start` with Node.js 22.13 or later, then open [Daymark](http://127.0.0.1:4173/). There are no packages to install.

The first screen is an interactive sample board. Choose **Start my board** to make your own account. The sample board and your personal board are separate. To stop Daymark, press Ctrl+C in the terminal.

## Lock your day

You can change today’s draft until you lock it. Locking is final, including any private note. Days close at midnight in the time zone saved when you created the account. Today shows your week and your check-in streak. A rest day keeps that streak going and opens Circle. A day with at least one habit mark counts as an active day. Past tiles in My progress are read-only.

## Use it with friends

1. Open **Circle** and create a circle.
2. Copy the invitation link or code.
3. Each friend signs in to the same Daymark site, then uses the invitation to join.

After you lock your own day, Circle opens the weekly race with your row first. Compare each friend’s Monday-to-Sunday marks and see your gap to the lead. One or both habits earns one active day. Tied scores share a rank. The race week follows the circle owner’s time zone so everyone sees the same dates. Send a **Spark** to cheer someone on. Open **Earlier marks** for recent check-ins. Private notes stay on the personal board.

**Pace duel** puts you and a rival on two tracks. Auto picks the closest person ahead of you or the strongest challenger if you lead. You can pick any circle member and switch back to Auto. The choice is saved for that circle on your device.

**Last week** shows the winning pace and shared first places once the prior week has ended in every eligible member’s time zone. The recap uses current circle members who were eligible that week.

On a private hosted Daymark site, each friend also needs access to the site itself. Grant that access before sharing the circle invite. Localhost is a preview for this computer.

## Use it on a phone

Open Daymark in your mobile browser. On iOS, use **Share → Add to Home Screen** in Safari. On supported Android browsers, use **Install app** or **Add to Home Screen**. Settings includes the install action.

After a signed-in online visit, Daymark keeps your personal board available on that device. You can draft offline. Use **Retry** when the connection returns, then lock the draft before the day ends. Circle actions need a connection. Installed updates wait for you to apply them or close the app. Settings lets you export your personal board as JSON.

## Run or deploy the project

- `npm test` checks daily locking and the midnight cutoff, circle access, calendar and streak calculations, and the PWA’s offline cache.
- `npm run build` produces the Sites Worker at `dist/server/index.js`. The hosted Worker expects the platform’s verified account headers and its `DB` D1 binding. The migrations are under `drizzle/`.
- `npm start` starts the standalone version. It uses local account sessions and SQLite under `.daymark/`. Use a persistent `DAYMARK_DATA_DIR` and back it up if self-hosting.
- For a shared standalone deployment, put the app behind HTTPS and set `DAYMARK_ORIGIN` to its public HTTPS origin. `DAYMARK_HOST` and `PORT` control its listener. Standalone email addresses serve as usernames. Password recovery is not configured.

The hosted and standalone versions use separate databases.
