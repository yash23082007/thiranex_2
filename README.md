# TaskFlow

A small full-stack task management application for learning authentication,
API integration, CRUD operations, dynamic rendering, and real-time updates.

## Features

- Register, sign in, and sign out with secure HTTP-only session cookies.
- Passwords are hashed with PBKDF2 before they are stored.
- Create, read, update, delete, filter, and search tasks.
- Track task status, priority, description, and due dates.
- Server-sent events push task changes to open browser tabs in real time.
- Responsive layout for desktop, tablet, and mobile screens.

## Run

```bash
npm start
```

Open `http://localhost:3000`.

## Project Structure

```text
server.js          Node HTTP server, auth routes, task API, static file serving
public/index.html  Application markup
public/styles.css  Responsive UI styles
public/app.js      Frontend state, API calls, rendering, and task actions
data/db.json       Local JSON database created automatically at runtime
```

## API Overview

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/asks`
- `GET /api/tasks/stream`
- `POST /api/tasks`
- `PATCH /api/tasks/:id`
- `DELETE /api/tasks/:id`
