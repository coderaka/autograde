import { initDb, getStudents, getStudentById } from '../lib/db.js';

async function main() {
  await initDb();
  console.log("Student '2026-05-16':", getStudentById('2026-05-16'));
  console.log("Total students:", getStudents().length);
  // List first 5 students
  console.log("First 5 students:", getStudents().slice(0, 5));
}

main().catch(console.error);
