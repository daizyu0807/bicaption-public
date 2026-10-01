import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRenderSubtitleOverlay, getSubtitlePreview } from '../src/overlay-preview.js';
test('preview is visible while idle without any recorded captions',()=>{
 assert.equal(shouldRenderSubtitleOverlay('preview','idle',false),true);
 assert.equal(shouldRenderSubtitleOverlay('hidden','idle',false),false);
 assert.equal(shouldRenderSubtitleOverlay('subtitle','streaming',false),true);
});
test('preview uses source and target display languages without transcription',()=>{
 assert.deepEqual(getSubtitlePreview('auto','zh-TW'),{sourceText:'This is a preview of your live captions.',translatedText:'這是即時字幕的預覽。'});
 assert.equal(getSubtitlePreview('zh-TW','en').sourceText,'這是即時字幕的預覽。');
});
