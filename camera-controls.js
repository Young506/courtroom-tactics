(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.CourtCameraControls=api;})(typeof globalThis!=='undefined'?globalThis:this,()=>{
  'use strict';
  class CameraControls {
    constructor(canvas,handlers){
      this.canvas=canvas;this.handlers=handlers;this.points=new Map();this.touch=null;this.listeners=[];
      this.on('contextmenu',e=>e.preventDefault());
      this.on('pointerdown',e=>this.down(e));this.on('pointermove',e=>this.move(e));
      for(const event of ['pointerup','pointercancel','lostpointercapture'])this.on(event,e=>this.up(e));
      this.on('wheel',e=>{e.preventDefault();handlers.zoom(Math.exp(e.deltaY*.001));},{passive:false});
    }
    on(type,fn,options){this.canvas.addEventListener(type,fn,options);this.listeners.push([type,fn,options]);}
    pair(){const p=[...this.points.values()].filter(p=>p.touch).slice(0,2);return p.length===2?{x:(p[0].x+p[1].x)/2,y:(p[0].y+p[1].y)/2,span:Math.max(1,Math.hypot(p[1].x-p[0].x,p[1].y-p[0].y))}:null;}
    down(e){
      if(![0,1,2].includes(e.button)&&e.pointerType!=='touch')return;
      e.preventDefault();this.canvas.focus?.({preventScroll:true});this.canvas.setPointerCapture?.(e.pointerId);
      this.points.set(e.pointerId,{x:e.clientX,y:e.clientY,touch:e.pointerType==='touch',pan:e.button===2||e.button===1||e.shiftKey});this.touch=this.pair();
    }
    move(e){
      const p=this.points.get(e.pointerId);if(!p)return;e.preventDefault();
      const dx=e.clientX-p.x,dy=e.clientY-p.y;p.x=e.clientX;p.y=e.clientY;
      const pair=this.pair();
      if(pair){if(this.touch){this.handlers.pan(pair.x-this.touch.x,pair.y-this.touch.y);this.handlers.zoom(this.touch.span/pair.span);}this.touch=pair;return;}
      this.touch=null;if(p.pan)this.handlers.pan(dx,dy);else this.handlers.rotate(dx,dy);
    }
    up(e){this.points.delete(e.pointerId);this.touch=this.pair();}
    dispose(){for(const [type,fn,options]of this.listeners)this.canvas.removeEventListener(type,fn,options);this.points.clear();this.listeners=[];}
  }
  return {CameraControls};
});
