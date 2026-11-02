"""Small CLI extension; every mutation goes through the Ledger facade."""

from .constants import BRIDGE_SOCKET
from .receipt_delivery import LedgerReceiver, NativeWakeAdapter
from .util import read_json_file

COMMANDS = frozenset(('receipt-enqueue', 'receipt-receive', 'receipt-get', 'receipt-review',
                      'receipt-deliver', 'receipt-drain', 'receipt-status', 'decision-create',
                      'decision-update', 'decision-get', 'decisions'))


def add_parsers(sub):
    for name in ('receipt-enqueue', 'receipt-receive', 'decision-create'):
        command = sub.add_parser(name)
        command.add_argument('--json', required=True, dest='json_path')
        if name == 'decision-create':
            command.add_argument('--actor', required=True)
        if name == 'receipt-receive':
            command.add_argument('--wake-controller', action='store_true')
            command.add_argument('--sync-wake', action='store_true', help='explicitly await native wake; passive default is durable ACK')
            command.add_argument('--bridge-socket', default=BRIDGE_SOCKET)
    get = sub.add_parser('receipt-get')
    get.add_argument('event_id')
    review = sub.add_parser('receipt-review')
    review.add_argument('event_id')
    review.add_argument('--json', required=True, dest='json_path')
    review.add_argument('--actor', required=True)
    deliver = sub.add_parser('receipt-deliver')
    deliver.add_argument('event_id')
    deliver.add_argument('--target-state')
    deliver.add_argument('--wake-controller', action='store_true')
    deliver.add_argument('--bridge-socket', default=BRIDGE_SOCKET)
    drain = sub.add_parser('receipt-drain', help='bounded manual recovery; unknown is read/reconcile only')
    drain.add_argument('--target-state')
    drain.add_argument('--wake-controller', action='store_true')
    drain.add_argument('--bridge-socket', default=BRIDGE_SOCKET)
    drain.add_argument('--limit', type=int, default=20)
    status = sub.add_parser('receipt-status')
    status.add_argument('event_id')
    status.add_argument('--queue', choices=('receipt', 'wake'), default='receipt')
    update = sub.add_parser('decision-update')
    update.add_argument('decision_id')
    update.add_argument('--json', required=True, dest='json_path')
    update.add_argument('--actor', required=True)
    get_decision = sub.add_parser('decision-get')
    get_decision.add_argument('decision_id')
    get_decision.add_argument('--history', action='store_true')
    query = sub.add_parser('decisions')
    query.add_argument('--task')
    query.add_argument('--decision-state', choices=('pending', 'decided', 'action-pending', 'verified'))
    query.add_argument('--waiting', choices=('waiting-user', 'waiting-external', 'controller'))
    query.add_argument('--include-test', action='store_true', help='explicitly inspect isolated test statistics')


def execute(ledger, args):
    command = args.command
    if command == 'receipt-enqueue':
        return ledger.enqueue_receipt(read_json_file(args.json_path))
    if command == 'receipt-receive':
        adapter = NativeWakeAdapter(socket_path=args.bridge_socket) if args.wake_controller else None
        return ledger.receive_receipt(read_json_file(args.json_path), wake_adapter=adapter,
                                      wake_mode='sync' if args.sync_wake else 'durable')
    if command == 'receipt-get':
        return ledger.get_receipt(args.event_id)
    if command == 'receipt-review':
        return ledger.review_receipt(args.event_id, read_json_file(args.json_path), actor_id=args.actor)
    if command in ('receipt-deliver', 'receipt-drain'):
        adapter = NativeWakeAdapter(socket_path=args.bridge_socket) if args.wake_controller else None
        target = ledger
        if args.target_state:
            from .ledger import Ledger
            target = Ledger(args.target_state)
        target.wake_adapter = adapter
        receiver = LedgerReceiver(target)
        if command == 'receipt-deliver':
            return ledger.dispatch_receipt(args.event_id, receiver)
        result = ledger.drain_receipts(receiver=receiver, limit=args.limit)
        if adapter is not None:
            result.extend(target.drain_receipts(wake_adapter=adapter, limit=args.limit))
        return result
    if command == 'receipt-status':
        return ledger.delivery_status(args.event_id, queue=args.queue)
    if command == 'decision-create':
        return ledger.create_decision(read_json_file(args.json_path), actor_id=args.actor)
    if command == 'decision-update':
        return ledger.update_decision(args.decision_id, read_json_file(args.json_path), actor_id=args.actor)
    if command == 'decision-get':
        return ledger.get_decision(args.decision_id, history=args.history)
    if command == 'decisions':
        return ledger.decisions_snapshot(include_test=args.include_test, task_id=args.task,
                                         state=args.decision_state, waiting=args.waiting)
    raise ValueError('unsupported receipt command')
