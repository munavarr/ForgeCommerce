import 'reflect-metadata';
import { createInterface, emitKeypressEvents } from 'node:readline';
import { createDataSource } from '../database/options';
import { quoteIdentifier, migrationStatus, verifyDatabaseIdentity } from '../database/safety';
import { credentials } from './auth.service';
import { hashPassword } from './password';

async function hiddenPassword(prompt:string):Promise<string> {
  process.stdout.write(prompt);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve,reject)=>{
    let value='', tooLong=false;
    const finish=()=>{ process.stdin.off('keypress',onKey); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); };
    const onKey=(text:string,key:{name?:string;ctrl?:boolean})=>{
      if(key.ctrl && key.name==='c') { finish(); reject(new Error('Cancelled')); }
      else if(key.name==='return' || key.name==='enter') {
        finish(); if(tooLong) reject(new Error('Password is too long')); else resolve(value);
      }
      else if(key.name==='backspace') value=[...value].slice(0,-1).join('');
      else if(text && !key.ctrl) {
        // Keep echo disabled until Enter, even after an oversized paste; reject rather than truncate.
        if(Buffer.byteLength(value+text,'utf8')>1024) tooLong=true;
        else if(!tooLong) value+=text;
      }
    };
    process.stdin.on('keypress',onKey);
  });
}
export async function createAdministrator(input:unknown) {
  const v=credentials(input), hash=await hashPassword(v.password), db=createDataSource(true);
  try {
    await db.initialize();
    const identity=await verifyDatabaseIdentity(db);
    if(identity.role!==identity.owner || !(await migrationStatus(db)).ready) throw new Error('Provisioning requires migrated database owner access');
    // INSERT only: never silently promote/overwrite an existing customer or administrator.
    await db.query(`INSERT INTO ${quoteIdentifier(process.env['DB_SCHEMA']!)}.users(email,password_hash,role)
      VALUES ($1,$2,'administrator')`,[v.email,hash]);
  } finally { if(db.isInitialized) await db.destroy(); }
}
async function main() {
  if(process.argv.length!==2 || !process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Use an interactive terminal without arguments');
  const rl=createInterface({input:process.stdin,output:process.stdout});
  const email=await new Promise<string>(resolve=>rl.question('Administrator email: ',resolve)); rl.close();
  const password=await hiddenPassword('Password (hidden): '), confirmation=await hiddenPassword('Confirm password (hidden): ');
  if(password!==confirmation) throw new Error('Passwords do not match');
  await createAdministrator({email,password});
  process.stdout.write('Administrator created. Email remains unverified.\n');
}
if(require.main===module) void main().catch(()=>{
  process.stderr.write('Administrator creation failed. Check terminal, input, unique email, migration state and owner credentials.\n');
  process.exitCode=1;
});
