import { initDb } from '../lib/db.js';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const db = await initDb();
  
  // 1. Delete ghost student
  db.run("DELETE FROM students WHERE id = '2026-05-16'");
  console.log("Deleted ghost student '2026-05-16'.");

  // 2. Fix submission 1
  db.run(`UPDATE submissions 
          SET student_id = '524030910196', 
              pdf_path = 'midterm/524030910196_刘羽翯.pdf' 
          WHERE id = 1`);
  console.log("Updated submission 1 to point to '524030910196' (刘羽翯).");

  // 3. Save database
  const data = db.export();
  const buffer = Buffer.from(data);
  writeFileSync(join(__dirname, '..', 'db', 'autograde.db'), buffer);
  console.log("Saved database successfully!");
}

main().catch(console.error);
