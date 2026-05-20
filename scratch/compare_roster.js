import { initDb, getStudents } from '../lib/db.js';
import XLSX from 'xlsx';

async function main() {
  await initDb();
  const dbStudents = getStudents();
  
  const wb = XLSX.readFile('/Users/chihao/Library/Mobile Documents/iCloud~md~obsidian/Documents/ObsidianLib/30-Area/Teaching/2026-Spring-Stochastic-Processes/AI2613-2026-roster.xlsx');
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const excelRows = XLSX.utils.sheet_to_json(sheet);
  
  console.log('DB students count:', dbStudents.length);
  console.log('Excel rows count:', excelRows.length);
  
  const excelMap = new Map();
  excelRows.forEach(r => {
    const id = String(r['学号'] || r['Student ID'] || r['id']).trim();
    const name = String(r['姓名'] || r['Name'] || r['name']).trim();
    const email = String(r['电子邮箱'] || r['邮箱'] || r['Email'] || r['email'] || '').trim();
    excelMap.set(id, { name, email });
  });

  const dbMap = new Map();
  dbStudents.forEach(r => {
    dbMap.set(r.id, { name: r.name, email: r.email });
  });

  console.log('\n--- ID in DB but not in Excel ---');
  for (const [id, val] of dbMap.entries()) {
    if (!excelMap.has(id)) {
      console.log(`ID: ${id} | Name: ${val.name} | Email: ${val.email}`);
    }
  }

  console.log('\n--- ID in Excel but not in DB ---');
  for (const [id, val] of excelMap.entries()) {
    if (!dbMap.has(id)) {
      console.log(`ID: ${id} | Name: ${val.name} | Email: ${val.email}`);
    }
  }

  console.log('\n--- ID in both but Name/Email mismatch ---');
  for (const [id, excelVal] of excelMap.entries()) {
    if (dbMap.has(id)) {
      const dbVal = dbMap.get(id);
      if (excelVal.name !== dbVal.name || excelVal.email !== dbVal.email) {
        console.log(`ID: ${id} | Excel: ${excelVal.name} (${excelVal.email}) | DB: ${dbVal.name} (${dbVal.email})`);
      }
    }
  }
}

main().catch(console.error);
