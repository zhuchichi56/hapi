import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { businessError, sameDirectory, isModelReply, testCommand } from './accept-live.mjs';

test('HTTP 200 business failure remains an error', () => {
    assert.match(businessError({type:'error',message:'RPC target unavailable',code:'missing'}), /RPC target unavailable/);
    assert.match(businessError({success:false,error:'failed'}), /failed/);
    assert.equal(businessError({type:'success',sessionId:'s'}), null);
});
test('accept actual Codex final reply, never user or tool echoes', () => {
    const message = (role, type) => ({content:{role,content:{type:'codex',data:{type,message:'MIGRATION_OK'}}}});
    assert.equal(isModelReply(message('agent','message')), true);
    assert.equal(isModelReply(message('user','message')), false);
    assert.equal(isModelReply(message('agent','tool-call-result')), false);
});
test('canonical and physical project paths match; other directories do not', () => {
    const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hapi-realpath-'));
    try {
        fs.mkdirSync(path.join(tmp,'work'));fs.symlinkSync(path.join(tmp,'work'),path.join(tmp,'link'));
        assert.equal(sameDirectory(path.join(tmp,'work'),path.join(tmp,'link')), true);
        assert.equal(sameDirectory(tmp,path.join(tmp,'link')), false);
        assert.equal(sameDirectory(undefined,path.join(tmp,'link')), false);
        const command=testCommand('nonce',path.join(tmp,'proof'),path.join(tmp,'work'));
        execFileSync('/bin/zsh',['-n','-c',command]);
        assert.ok(!command.includes('; status='));
        assert.ok(command.includes('$(pwd -P)'));
    } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
});
