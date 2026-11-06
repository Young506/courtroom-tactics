const {test}=require('node:test');
const assert=require('node:assert/strict');
const E=require('./engine.js');

test('the example keeps player positions and ball possession continuous',()=>{
 const t=E.example();
 assert.equal(t.steps.length,4);
 for(let i=0;i<t.steps.length-1;i++){
  const end=E.endpoint(t.steps[i]);
  assert.deepEqual(end.players,t.steps[i+1].players);
  assert.equal(end.ballOwner,t.steps[i+1].ballOwner);
 }
 assert.equal(t.steps[3].ballOwner,'a5');
 assert.equal(E.endpoint(t.steps[3]).ballOwner,null);
 assert.deepEqual(E.endpoint(t.steps[3]).ball,{x:500,y:113});
});
test('animation reaches the authored player and pass endpoints',()=>{
 const t=E.example(),s=t.steps[1];
 assert.deepEqual(E.sampled(s,0).players,s.players);
 assert.deepEqual(E.sampled(s,1).players,E.endpoint(s).players);
 const receiver=t.steps[2].players.find(p=>p.id==='a5');
 assert.deepEqual(E.sampled(t.steps[2],1).ball,{x:receiver.x+30,y:receiver.y-23});
});
test('adding a step copies the result and does not share editable objects',()=>{
 const t=E.example(),next=E.nextStep(t.steps[0]);
 assert.deepEqual(next.players,E.endpoint(t.steps[0]).players);
 assert.equal(next.actions.length,0);
 next.players[0].x=0;
 assert.notEqual(next.players[0].x,t.steps[0].players[0].x);
});
test('full court preserves the upper half; returning folds the other basket correctly',()=>{
 const t=E.example(),before=E.clone(t.steps);
 E.switchCourt(t,'full');
 assert.deepEqual(t.steps,before);
 E.switchCourt(t,'half');
 assert.deepEqual(t.steps,before);
 E.switchCourt(t,'full');
 t.steps[0].players[0]={...t.steps[0].players[0],x:700,y:1500};
 t.steps[3].actions[0].to={x:500,y:1767};
 E.switchCourt(t,'half');
 assert.equal(t.steps[0].players[0].x,300);
 assert.equal(t.steps[0].players[0].y,380);
 assert.deepEqual(t.steps[3].actions[0].to,{x:500,y:113});
});
test('export/import retains notes, player state and actions with fresh tactic identity',()=>{
 const t=E.example(),copy=E.validate(JSON.parse(JSON.stringify(t)));
 assert.notEqual(copy.id,t.id);
 assert.equal(copy.title,t.title);
 assert.equal(copy.steps[3].notes,t.steps[3].notes);
 assert.deepEqual(copy.steps[3].players,t.steps[3].players);
 assert.equal(copy.steps[3].actions[0].type,'shoot');
});
test('invalid and oversized imports are rejected before modifying the playbook',()=>{
 assert.throws(()=>E.validate(null));
 assert.throws(()=>E.validate({schema:'wrong',version:1}));
 const bad=E.example();bad.steps[0].players[0].x=Infinity;
 assert.throws(()=>E.validate(bad),/坐标/);
 const duplicate=E.example();duplicate.steps[0].players[1].id=duplicate.steps[0].players[0].id;
 assert.throws(()=>E.validate(duplicate),/球员/);
 const orphan=E.example();orphan.steps[0].actions[0].playerId='missing';
 assert.throws(()=>E.validate(orphan),/球员/);
 const tooMany=E.example();tooMany.steps=Array(101).fill(tooMany.steps[0]);
 assert.throws(()=>E.validate(tooMany),/100/);
});

test('3D preview uses exactly the same player motion as the 2D animation',()=>{
 const t=E.example();
 for(const progress of [0,.25,.5,.75,1]){
  assert.deepEqual(E.sample3D(t.steps[1],progress).players,E.sampled(t.steps[1],progress).players);
 }
});
test('3D pass reaches its recipient and shots finish at the 3.05m hoop',()=>{
 const t=E.example(),recipient=t.steps[2].players.find(p=>p.id==='a5');
 assert.equal(E.sample3D(t.steps[2],1).ball.x,recipient.x);
 assert.equal(E.sample3D(t.steps[2],1).ball.y,recipient.y);
 const end=E.sample3D(t.steps[3],1).ball;
 assert.equal(end.x,500);assert.equal(end.y,113);
 assert.ok(Math.abs(end.height-3.05)<1e-9);
 assert.ok(E.sample3D(t.steps[3],.5).ball.height>3.05);
});
test('3D dribble bounces above the floor and loose-ball state stays visible',()=>{
 const t=E.example();
 for(const progress of [.1,.2,.3,.4,.5,.6,.7,.8,.9]){
  const height=E.sample3D(t.steps[1],progress).ball.height;
  assert.ok(height>=.2&&height<=1.01);
 }
 const s=E.nextStep(t.steps[3]);
 assert.equal(s.ballOwner,null);
 assert.equal(E.sample3D(s,0).ball.x,500);
 assert.equal(E.sample3D(s,0).ball.y,113);
});
