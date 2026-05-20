import { initDb, findStudentByName, getStudentById } from '../lib/db.js';

async function main() {
  await initDb();
  console.log("Find '刘羽翯':", findStudentByName('刘羽翯'));
  console.log("Find '刘羽馨':", findStudentByName('刘羽馨'));
  console.log("Get student by ID '524030910196':", getStudentById('524030910196'));
  console.log("Get student by ID '524030910186':", getStudentById('524030910186'));
}

main().catch(console.error);
