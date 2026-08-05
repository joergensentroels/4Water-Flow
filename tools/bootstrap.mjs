// Create the first administrator. Without this a fresh deployment is a locked door: no people exist, the dev
// sign-in is disabled under production, OIDC deliberately refuses identities that are not on the roster, and
// there is no admin to issue an invitation. The app came up looking healthy and let nobody in.
//
//   node tools/bootstrap.mjs someone@4water.org "Their Name"
//
// Idempotent. Safe to run twice, and safe to run on a live system — it never removes anything.
import { openDb, migrate } from "../src/db.mjs";
import { loadPattern, patternFileFor } from "../src/config.mjs";
import { seedRoles } from "../src/seed.mjs";
import { createInvite } from "../src/auth.mjs";

// `roles` lets a caller that already has a pattern in hand pass its role list, instead of this reaching for
// whatever config/pattern.json contains. Creating an administrator must not decide what season exists.
export function bootstrapAdmin(db, { email, name, baseUrl = "", roles = null }) {
  if (!email || !/.+@.+/.test(email)) return { ok: false, reason: "bad_email" };

  migrate(db);                                  // still safe to point at a database that has never been migrated
  // patternFileFor() for consistency with every other entry point, not because it changes an outcome today:
  // `validatePattern` now requires the same three role names of every config, so which file this reads cannot
  // alter the result. Honouring the seam anyway costs one call and removes the need to reason about that each
  // time somebody looks — which is the reasoning that let backup.mjs read the wrong file on a deleting path.
  seedRoles(db, roles ?? loadPattern(patternFileFor()).roles);  // the roles table, and deliberately nothing else

  const adminRole = db.prepare("SELECT id FROM roles WHERE name='admin'").get();
  if (!adminRole) return { ok: false, reason: "no_admin_role" };

  // Reuse an existing record rather than creating a duplicate person for the same address.
  let person = db.prepare("SELECT id, name FROM people WHERE contact = ?").get(email);
  let created = false;
  if (!person) {
    // No auth_subject: the first OIDC sign-in with this email adopts this record (see linkIdentity), and an
    // invite link works whether or not OIDC is ever configured.
    const r = db.prepare("INSERT INTO people (name, contact, auth_provider, auth_subject) VALUES (?,?,?,NULL)")
      .run(name || email, email, "oidc");
    person = { id: Number(r.lastInsertRowid), name: name || email };
    created = true;
  }

  const already = db.prepare(`SELECT 1 FROM person_roles pr JOIN roles r ON r.id=pr.role_id
                               WHERE pr.person_id=? AND r.name='admin'`).get(person.id);
  db.prepare("INSERT OR IGNORE INTO person_roles (person_id, role_id) VALUES (?,?)").run(person.id, adminRole.id);

  // Also grant planner: a one-person setup needs to do both jobs, and it is trivially removable later.
  const plannerRole = db.prepare("SELECT id FROM roles WHERE name='planner'").get();
  if (plannerRole) db.prepare("INSERT OR IGNORE INTO person_roles (person_id, role_id) VALUES (?,?)").run(person.id, plannerRole.id);

  // An invite link is the way in when OIDC is not configured yet — which is the normal state on day one.
  const token = createInvite(db, { email, roleName: "admin" });
  return {
    ok: true, personId: person.id, created, alreadyAdmin: Boolean(already),
    inviteToken: token,
    inviteUrl: baseUrl ? `${baseUrl.replace(/\/+$/, "")}/invite/${token}` : `/invite/${token}`,
  };
}

if (process.argv[1] && (await import("node:url")).pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [email, name] = process.argv.slice(2);
  if (!email) {
    console.error('usage: node tools/bootstrap.mjs <email> "<name>"');
    console.error("       creates the first administrator and prints a single-use sign-in link");
    process.exit(1);
  }
  const db = openDb();
  migrate(db);
  const r = bootstrapAdmin(db, { email, name, baseUrl: process.env.FOURWATER_BASE_URL || "" });
  if (!r.ok) { console.error(`bootstrap failed: ${r.reason}`); process.exit(2); }

  console.log(`${r.created ? "Created" : "Found"} ${email} (person ${r.personId})`);
  console.log(r.alreadyAdmin ? "Already an administrator." : "Granted: administrator, planner.");
  console.log(`\nOpen this link once to sign in. It expires in 14 days and works only once:\n  ${r.inviteUrl}`);
  if (!process.env.FOURWATER_BASE_URL) {
    console.log(`\n(Set FOURWATER_BASE_URL=https://plan-cph.4water.org to get a full URL instead of a path.)`);
  }
  db.close();
}
