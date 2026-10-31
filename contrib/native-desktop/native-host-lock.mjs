import { spawn } from 'node:child_process';

// flock is released by the OS even if the host is killed. Never unlink the
// lock file: replacing it would let two contenders lock different inodes.
const guard = String.raw`
use strict; use warnings;
use Fcntl qw(:DEFAULT :flock);
sysopen(my $lock, $ARGV[0], O_CREAT|O_RDWR|O_NOFOLLOW, 0600) or die "open bridge lock: $!";
my @s = stat($lock);
die "Private bridge lock required" unless -f $lock && $s[4] == $< && ($s[2] & 077) == 0;
unless (flock($lock, LOCK_EX|LOCK_NB)) { exit 75; }
$|=1; print "locked\n";
while (sysread(STDIN, my $buffer, 1024)) {}
`;

export function acquireHostLock(socketPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/perl', ['-e', guard, `${socketPath}.lock`], {stdio:['pipe','pipe','ignore']});
    let ready = false, released = false, lost = () => {};
    const release = () => { if (!released) { released = true; child.stdin.end(); } };
    const timer = setTimeout(() => { release(); child.kill(); reject(Error('Bridge lock acquisition timed out')); }, 3000);
    child.stdin.on('error', () => {});
    child.stdout.once('data', data => {
      if (data.toString().trim() !== 'locked' || released) return;
      ready = true; clearTimeout(timer);
      resolve({ release, onLost(callback) { lost = callback; } });
    });
    child.once('error', error => { clearTimeout(timer); if (!ready) reject(error); else if (!released) lost(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (!ready) reject(Error(code === 75 ? 'Native bridge is already running' : 'Bridge lock helper unavailable'));
      else if (!released) lost(Error('Bridge lock was lost'));
    });
  });
}
