#!/usr/bin/perl
use strict;
use warnings;
use IO::Socket::UNIX;
use Socket qw(SOCK_STREAM);
use Fcntl qw(S_ISSOCK S_ISDIR);
use File::Basename qw(dirname);
use Errno qw(ECONNREFUSED ENOENT);
my $path = $ARGV[0] // "$ENV{HOME}/.local/lib/hapi-mini/desktop/host.sock";
my @directory = lstat(dirname($path));
die "Forward directory is not private\n" unless @directory && S_ISDIR($directory[2]) && $directory[4] == $< && !($directory[2] & 0077);
my @before = lstat($path);
exit 0 unless @before;
die "Refusing to replace foreign forward path\n" unless S_ISSOCK($before[2]) && $before[4] == $<;
my $peer = IO::Socket::UNIX->new(Type => SOCK_STREAM, Peer => $path);
if ($peer) { close($peer); exit 0; }
die "Forward socket could not be checked\n" unless $! == ECONNREFUSED || $! == ENOENT;
my @after = lstat($path);
exit 0 unless @after;
die "Forward socket changed during check\n" unless $before[0] == $after[0] && $before[1] == $after[1];
unlink($path) or die "Stale forward socket could not be removed\n";
print "Removed stale native forward socket\n";
