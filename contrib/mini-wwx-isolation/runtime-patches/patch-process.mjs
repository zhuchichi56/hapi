import {readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {join,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
const src=process.argv[2],here=dirname(fileURLToPath(import.meta.url));
function patch(path, transforms){const p=join(src,path);let s=readFileSync(p,'utf8');for(const [needle,replacement]of transforms){if(s.split(needle).length!==2)throw Error('Unexpected source at '+path+': '+needle);s=s.replace(needle,replacement);}writeFileSync(p,s);}
copyFileSync(join(here,'src/utils/guestProcess.ts'),join(src,'src/utils/guestProcess.ts'));

const processPath=join(src,'src/utils/process.ts');
writeFileSync(processPath,"import { guestProcessStartMarker, guestProcessCommandLine, guestProcessTree } from './guestProcess';\n"+readFileSync(processPath,'utf8'));
patch('src/utils/process.ts',[
 ['export function getProcessStartMarker(pid: number): string | null {',"export function getProcessStartMarker(pid: number): string | null {\n  if (process.platform === 'darwin' && process.env.HAPI_GUEST_PORT_MIN) return guestProcessStartMarker(pid);"],
 ['function getPosixProcessCommandLine(pid: number): string | null {',"function getPosixProcessCommandLine(pid: number): string | null {\n  if (process.platform === 'darwin' && process.env.HAPI_GUEST_PORT_MIN) return guestProcessCommandLine(pid);"],
 ["function collectProcessTree(pid: number): number[] | 'scan_failed' {","function collectProcessTree(pid: number): number[] | 'scan_failed' {\n  if (process.platform === 'darwin' && process.env.HAPI_GUEST_PORT_MIN) return guestProcessTree(pid);"]
]);
const orphanPath=join(src,'src/runner/orphanReap.ts');
writeFileSync(orphanPath,"import { guestProcessSnapshots } from '@/utils/guestProcess';\n"+readFileSync(orphanPath,'utf8'));
patch('src/runner/orphanReap.ts',[
 ['export function listPosixProcessesWithStartMarker(): ProcessSnapshot[] {',"export function listPosixProcessesWithStartMarker(): ProcessSnapshot[] {\n    if (process.platform === 'darwin' && process.env.HAPI_GUEST_PORT_MIN) return guestProcessSnapshots();"]
]);
patch('src/codex/shared/runtime.ts',[
 ["process.platform === 'win32' ? tmpdir() : '/tmp'","process.env.HAPI_GUEST_PORT_MIN ? tmpdir() : (process.platform === 'win32' ? tmpdir() : '/tmp')"]
]);
