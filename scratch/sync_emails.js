import { initDb, getStudents, upsertStudent } from '../lib/db.js';
import XLSX from 'xlsx';

async function main() {
  await initDb();
  
  const wb = XLSX.readFile('/Users/chihao/Library/Mobile Documents/iCloud~md~obsidian/Documents/ObsidianLib/30-Area/Teaching/2026-Spring-Stochastic-Processes/AI2613-2026-roster.xlsx');
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const excelRows = XLSX.utils.sheet_to_json(sheet);
  
  console.log('Importing emails for', excelRows.length, 'students...');
  
  let updated = 0;
  for (const r of excelRows) {
    const id = String(r['学号'] || r['Student ID'] || r['id']).trim();
    const name = String(r['姓名'] || r['Name'] || r['name']).trim();
    const email = String(r['电子邮箱'] || r['邮箱'] || r['Email'] || r['email'] || '').trim();
    
    if (id && name) {
      upsertStudent(id, name, email || null);
      updated++;
    }
  }
  
  console.log('Done! Updated', updated, 'students.');
}

main().catch(console.error);
