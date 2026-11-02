"""Private queue CLI. No HTTP projection, native tool invocation or decisions."""

from .errors import ValidationError
from .util import read_json_file

ACTIONS = ('list', 'ready', 'package', 'metrics', 'claim', 'start', 'renew', 'submit',
           'release', 'reconcile', 'configure', 'priority')


def add_parser(sub):
    parser = sub.add_parser('review-queue', help='private verification candidates; parent alone reviews/decides')
    parser.add_argument('action', choices=ACTIONS)
    parser.add_argument('--json', dest='json_path')
    parser.add_argument('--event')
    parser.add_argument('--actor')
    parser.add_argument('--include-test', action='store_true')
    parser.add_argument('--limit', type=int, default=20)


def execute(ledger, args):
    if args.action in ('list', 'ready'):
        return ledger.verification_snapshot(include_test=args.include_test, limit=args.limit, ready=args.action == 'ready')
    if args.action == 'metrics':
        return ledger.verification_metrics(include_test=args.include_test)
    if args.action == 'package':
        if not args.event:
            raise ValidationError('package requires --event')
        return ledger.verification_package(args.event)
    if not args.actor or not args.json_path:
        raise ValidationError('queue mutation requires --actor and --json')
    return ledger.verification(args.action, read_json_file(args.json_path), actor_id=args.actor)
