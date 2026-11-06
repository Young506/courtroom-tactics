const {test}=require('node:test');
const assert=require('node:assert/strict');
const {CameraControls}=require('./camera-controls.js');
const V=require('./video-model.js');
const Voice=require('./voice.js');
const E=require('./engine.js');
const P=require('./pinyin-pro.js');
const manifest=require('./mandarin.json');
class CanvasMock{
 constructor(){this.events=new Map();}
 addEventListener(name,fn){this.events.set(name,fn);}
 removeEventListener(name){this.events.delete(name);}
 focus(){} setPointerCapture(){}
 send(name,data){this.events.get(name)?.({button:0,pointerId:1,pointerType:'mouse',clientX:0,clientY:0,preventDefault(){},...data});}
}
function controls(){const canvas=new CanvasMock(),calls={rotate:[],pan:[],zoom:[]};const c=new CameraControls(canvas,Object.fromEntries(Object.keys(calls).map(name=>[name,(...args)=>calls[name].push(args)])));return {canvas,c,calls};}

test('left mouse rotates, right mouse pans without rotating',()=>{
 const {canvas,calls,c}=controls();
 canvas.send('pointerdown',{clientX:20,clientY:30});canvas.send('pointermove',{clientX:50,clientY:45});
 assert.deepEqual(calls.rotate,[[30,15]]);canvas.send('pointerup',{});
 canvas.send('pointerdown',{button:2,clientX:10,clientY:10});canvas.send('pointermove',{clientX:30,clientY:35});
 assert.deepEqual(calls.pan,[[20,25]]);assert.equal(calls.rotate.length,1);c.dispose();assert.equal(canvas.events.size,0);
});
test('two-finger translation pans and pinch changes zoom; finger lift does not jump',()=>{
 const {canvas,calls}=controls();
 canvas.send('pointerdown',{pointerId:1,pointerType:'touch',clientX:0,clientY:0});
 canvas.send('pointerdown',{pointerId:2,pointerType:'touch',clientX:100,clientY:0});
 canvas.send('pointermove',{pointerId:2,pointerType:'touch',clientX:200,clientY:20});
 assert.deepEqual(calls.pan[0],[50,10]);assert.ok(calls.zoom[0][0]<1);assert.equal(calls.rotate.length,0);
 canvas.send('pointerup',{pointerId:2,pointerType:'touch'});
 canvas.send('pointermove',{pointerId:1,pointerType:'touch',clientX:2,clientY:3});
 assert.deepEqual(calls.rotate[0],[2,3]);
});
test('cancelled gestures stop moving the camera',()=>{
 const {canvas,calls}=controls();canvas.send('pointerdown',{});canvas.send('pointercancel',{});canvas.send('pointermove',{clientX:100,clientY:100});
 assert.equal(calls.rotate.length,0);
});
test('export sizes cover landscape/portrait and 720p/1080p exactly',()=>{
 assert.deepEqual(V.dimensions('portrait',720),{width:720,height:1280});
 assert.deepEqual(V.dimensions('landscape',1080),{width:1920,height:1080});
 assert.deepEqual(V.dimensions('portrait',1080),{width:1080,height:1920});
 for(const o of ['portrait','landscape'])for(const q of [720,1080]){const l=V.layout(o,q);assert.ok(l.board.x+l.board.w<=l.width);assert.ok(l.board.y+l.board.h<=l.height);assert.ok(l.notes.y+l.notes.h<=l.height);}
});
test('narration is never cut off and exact frame boundaries select the next step',()=>{
 const steps=E.example().steps,plan=V.timeline(steps,[7,0,0,0],[1,1,1,1]);
 assert.ok(plan.steps[0].duration>=7.45);assert.equal(plan.frames,Math.round(plan.duration*30));
 assert.equal(V.at(plan,plan.steps[0].endFrame).item.index,1);
 assert.equal(V.at(plan,plan.frames-1).progress,1);
});
test('long descriptions paginate without dropping characters and receive readable dwell time',()=>{
 const text='篮球战术讲解'.repeat(100),lines=V.wrapText(text,10,s=>s.length),pages=V.paginate(lines,5);
 assert.equal(pages.flat().join(''),text);
 const plan=V.timeline([E.example().steps[0]],[],[pages.length]);assert.ok(plan.duration>=pages.length*3);
});
test('the MP4 signature check rejects WebM renamed to .mp4',()=>{
 assert.equal(V.isMp4(new Uint8Array([0,0,0,20,102,116,121,112,105,115,111,109])),true);
 assert.equal(V.isMp4(new Uint8Array([26,69,223,163,0,0,0,0,0,0,0,0])),false);
});
test('the offline voice bank covers every Chinese word in the example',()=>{
 assert.equal(Object.keys(manifest.syllables).length,2062);
 for(const step of E.example().steps){const normalized=Voice.normalize('第1步，'+step.title+'。'+step.notes);const tokens=P.pinyin(normalized,{toneType:'num',type:'array',v:true,neutralToneType:'num'});const parts=Voice.segments(tokens,manifest.syllables);assert.ok(parts.filter(p=>p.key).length>20);}
});
test('speech assembly places each syllable at its indexed offset with sentence pauses',()=>{
 const pcm=Float32Array.from({length:100},(_,i)=>i/100),parts=[{start:.1,duration:.2},{silence:.4},{start:.6,duration:.1}];
 const result=Voice.assemble(pcm,parts,100);
 assert.ok(result.length>=100);assert.equal(result[15],pcm[10]);assert.equal(result[77],pcm[60]);
});
