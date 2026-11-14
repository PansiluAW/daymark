CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  external_id TEXT UNIQUE,
  email TEXT UNIQUE,
  password_salt TEXT,
  password_hash TEXT,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  gym_goal INTEGER NOT NULL DEFAULT 3 CHECK (gym_goal BETWEEN 1 AND 7),
  nutrition_goal INTEGER NOT NULL DEFAULT 5 CHECK (nutrition_goal BETWEEN 1 AND 7),
  created_at INTEGER NOT NULL,
  CHECK (
    (external_id IS NOT NULL AND email IS NULL AND password_salt IS NULL AND password_hash IS NULL)
    OR (external_id IS NULL AND email IS NOT NULL AND password_salt IS NOT NULL AND password_hash IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX sessions_expiry ON sessions (expires_at);
--> statement-breakpoint
CREATE TABLE login_attempts (
  login_key TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE checkins (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  gym INTEGER NOT NULL DEFAULT 0 CHECK (gym IN (0, 1)),
  nutrition INTEGER NOT NULL DEFAULT 0 CHECK (nutrition IN (0, 1)),
  note TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);
--> statement-breakpoint
CREATE TABLE circles (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  invite_code TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE circle_members (
  circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (circle_id, user_id)
);
--> statement-breakpoint
CREATE INDEX circle_members_user ON circle_members (user_id, circle_id);
--> statement-breakpoint
CREATE UNIQUE INDEX circle_members_owner ON circle_members (circle_id) WHERE role = 'owner';
--> statement-breakpoint
CREATE TABLE cheers (
  circle_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (circle_id, author_id, subject_id, day),
  CHECK (author_id <> subject_id),
  FOREIGN KEY (circle_id, author_id) REFERENCES circle_members(circle_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (circle_id, subject_id) REFERENCES circle_members(circle_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (subject_id, day) REFERENCES checkins(user_id, day) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX cheers_subject ON cheers (subject_id, day, circle_id);
--> statement-breakpoint
CREATE TRIGGER checkins_remove_cheers_after_uncheck
AFTER UPDATE OF gym, nutrition ON checkins
WHEN NEW.gym = 0 AND NEW.nutrition = 0 AND (OLD.gym = 1 OR OLD.nutrition = 1)
BEGIN
  DELETE FROM cheers WHERE subject_id = NEW.user_id AND day = NEW.day;
END;
