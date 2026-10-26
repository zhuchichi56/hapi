#!/usr/bin/perl
use strict;
use warnings;
use JSON::PP qw(decode_json encode_json);
use IO::Socket::UNIX;
use IO::Select;
use Socket qw(SOCK_STREAM);
$| = 1;
my $root = $ENV{HOME} . '/.local';
my $socket = $root . '/state/native-desktop-bridge/host.sock';
my $runtime = '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node';
my $script = $root . '/lib/native-desktop-bridge/native-mcp.mjs';
sub ensure_host {
    my $peer = IO::Socket::UNIX->new(Type => SOCK_STREAM, Peer => $socket);
    if ($peer) { close($peer); return; }
    exec($runtime, $script) or die "Desktop host could not start\n";
}
ensure_host();
my $select = IO::Select->new(\*STDIN);
while (1) {
    if (!$select->can_read(10)) { ensure_host(); next; }
    my $line = <STDIN>;
    last if !defined($line);
    my $request = eval { decode_json($line) };
    next if !$request || !exists($request->{id});
    my $method = $request->{method} // '';
    my $response = {jsonrpc => '2.0', id => $request->{id}};
    if ($method eq 'initialize') {
        $response->{result} = {protocolVersion => $request->{params}{protocolVersion} // '2024-11-05', capabilities => {tools => {}}, serverInfo => {name => 'native-desktop-bridge', version => '0.1.0'}};
    } elsif ($method eq 'tools/list') { $response->{result} = {tools => []};
    } elsif ($method eq 'ping') { $response->{result} = {};
    } else { $response->{error} = {code => -32601, message => 'Method not found'}; }
    print encode_json($response), "\n";
}
