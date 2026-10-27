#!/usr/bin/perl
use strict;
use warnings;
# The existing LaunchAgent passes its original SSH command unchanged after this wrapper.
# Only reconnects run a preflight; active connections do not poll or touch the desktop.
die "Original SSH command required\n" unless @ARGV && $ARGV[0] eq '/usr/bin/ssh';
my $status = system('/usr/bin/ssh', '-S', 'none', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'mac-mini', '/usr/bin/perl', '.local/lib/hapi-mini/desktop/mini-socket-preflight.pl');
warn "Native forward preflight unavailable; trying the existing tunnel\n" if $status != 0;
exec(@ARGV) or die "Existing tunnel could not start\n";
