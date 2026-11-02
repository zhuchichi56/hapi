"""Validate the shipped replay against every schema keyword used here.

This stdlib checker covers this contract's subset, not arbitrary JSON Schema.
No external package installation or network is needed in the managed executor.
"""

import json
import sys
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[2]))
import math
import re
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SUPPORTED = {'$schema', '$id', 'title', '$defs', '$ref', 'type', 'properties', 'required',
             'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength',
             'maxLength', 'pattern', 'format', 'minimum', 'const', 'enum', 'anyOf', 'oneOf', 'x-contract'}


def validate(value, spec, root, path='$'):
    assert set(spec) <= SUPPORTED, ('unsupported schema keyword', set(spec) - SUPPORTED)
    if '$ref' in spec:
        name = spec['$ref'].removeprefix('#/$defs/') if hasattr(str, 'removeprefix') else spec['$ref'][8:]
        return validate(value, root['$defs'][name], root, path)
    for variant_key in ('anyOf', 'oneOf'):
        if variant_key in spec:
            count = 0
            for variant in spec[variant_key]:
                try:
                    validate(value, variant, root, path)
                    count += 1
                except AssertionError:
                    pass
            assert count >= 1 if variant_key == 'anyOf' else count == 1, (path, variant_key, count)
    if 'const' in spec:
        assert type(value) is type(spec['const']) and value == spec['const'], (path, 'const')
    if 'enum' in spec:
        assert value in spec['enum'], (path, 'enum')
    kind = spec.get('type')
    allowed_type = {'object': lambda v: isinstance(v, dict), 'array': lambda v: isinstance(v, list),
                    'string': lambda v: isinstance(v, str), 'boolean': lambda v: type(v) is bool,
                    'integer': lambda v: type(v) is int, 'number': lambda v: type(v) in (int, float) and math.isfinite(v),
                    'null': lambda v: v is None}
    if kind:
        assert allowed_type[kind](value), (path, kind, type(value).__name__)
    if kind == 'object':
        assert set(spec.get('required', [])) <= set(value), (path, 'missing', set(spec.get('required', [])) - set(value))
        if spec.get('additionalProperties') is False:
            assert set(value) <= set(spec.get('properties', {})), (path, 'extra', set(value) - set(spec.get('properties', {})))
        for key, item in value.items():
            if key in spec.get('properties', {}):
                validate(item, spec['properties'][key], root, path + '.' + key)
    if kind == 'array':
        assert len(value) >= spec.get('minItems', 0), (path, 'minItems')
        assert len(value) <= spec.get('maxItems', math.inf), (path, 'maxItems')
        if spec.get('uniqueItems'):
            assert len({json.dumps(item, sort_keys=True) for item in value}) == len(value), (path, 'uniqueItems')
        for index, item in enumerate(value):
            validate(item, spec.get('items', {}), root, path + '[%d]' % index)
    if kind == 'string':
        assert len(value) >= spec.get('minLength', 0), (path, 'minLength')
        assert len(value) <= spec.get('maxLength', math.inf), (path, 'maxLength')
        if 'pattern' in spec:
            assert re.search(spec['pattern'], value), (path, 'pattern')
        if spec.get('format') == 'date-time':
            try:
                parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
                assert parsed.tzinfo is not None
            except (ValueError, AssertionError):
                raise AssertionError((path, 'date-time'))
    if kind in ('integer', 'number') and 'minimum' in spec:
        assert value >= spec['minimum'], (path, 'minimum')


def main():
    schema = json.loads((ROOT / 'interface.json').read_text())
    sample = json.loads((ROOT / 'sample.json').read_text())
    checked = 0
    for entry in sample['snapshots']:
        validate(entry['snapshot'], schema, schema)
        checked += 1
    specs = {'enqueue_receipt': ('Receipt', 'DeliveryStatus'), 'receive_receipt': ('Receipt', 'ReceiptAck'),
             'review_receipt': ('ReceiptReviewInput', 'ReceiptReview'), 'create_decision': ('DecisionCreate', 'Decision'),
             'update_decision': ('DecisionUpdate', 'Decision'), 'dispatch_receipt': (None, 'DeliveryStatus'),
             'dispatch_wake': (None, 'DeliveryStatus')}
    for entry in sample['operations']:
        input_name, output_name = specs[entry['method']]
        if input_name:
            validate(entry['arguments']['data'], schema['$defs'][input_name], schema)
            checked += 1
        validate(entry['result'], schema['$defs'][output_name], schema)
        checked += 1
    for entry in sample['publicSnapshots']:
        validate(entry['snapshot'], schema['$defs']['PublicProjection'], schema)
        checked += 1
    validate(sample['hostSnapshot']['systemDecisions'], schema['$defs']['PublicProjection'], schema)
    checked += 1
    for history in sample['histories'].values():
        for decision in history:
            validate(decision, schema['$defs']['Decision'], schema)
            checked += 1
    print(json.dumps(dict(schemaVersion=1, validatedRecords=checked, snapshots=len(sample['snapshots']),
                          operations=len(sample['operations']), validator='stdlib-contract-subset'), sort_keys=True))


if __name__ == '__main__':
    main()
