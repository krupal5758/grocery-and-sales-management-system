# Grocery & Sales Management System

A web-based system for managing grocery store inventory and sales. Built as a fullstack project using AngularJS, Node.js, Express, and SQLite.

## What it does

- Add and manage products (name, category, unit, price, stock)
- Record sales with GST, discount, and payment mode (Cash / UPI / Card)
- Auto-generates invoices per sale
- Low stock alerts
- Sales reports with daily revenue chart and top products
- Data backup — export and import as JSON
- Audit log for all actions
- Dark mode

## Tech stack

- **Frontend:** AngularJS 1.8, HTML, CSS (no build step needed)
- **Backend:** Node.js + Express
- **Database:** SQLite via `sqlite3`
- **Auth:** JWT stored in cookie

## Setup

```bash
npm install
```

Copy the example env file and set your own secret:

```bash
cp .env.example .env
```

Start the server:

```bash
npm start
```

Open `http://localhost:3000` in your browser.

### First login

There is **no default password**. On first run, register an account at the
sign-up screen — the **first user to register is automatically made an admin**.

Alternatively, set `ADMIN_PASSWORD` in your `.env` before the first start to
seed an `admin` user with that password.

> **Production:** `JWT_SECRET` must be set or the server will refuse to start.
> Generate one with:
> `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

## Project structure

```
├── server.js         API routes
├── db.js             Database setup and schema
├── auth.js           JWT auth middleware
├── validate.js       Input validation helpers
├── public/
│   ├── index.html    Main page
│   ├── app.js        AngularJS controller
│   └── styles.css    Styles
└── .env.example      Environment variable reference
```

## Notes

- SQLite database file (`data.db`) is created automatically on first run
- All prices are in INR (₹)
- The `data.db` file is excluded from git — use the export feature for backups
