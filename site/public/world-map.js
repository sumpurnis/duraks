// Uzspēlēsim.lv front page: the living map of players' villages.
//
// Drawn procedurally on two canvases — no images, no copying between canvases (so privacy
// blockers such as Brave Shields that poison canvas reads can't blank it):
//   #cv  the ground, roads, trees and villages (redrawn only when the world changes or on resize)
//   #fx  everything that moves: smoke, walkers, bunting, the free plot, "+1", and taps.
// The first part is the drawing kit (villages for 10 levels, roads that wear from grass to
// cobbles); the second part reads /api/world (platform/world.js), animates it and lets the
// visitor move around (drag / two fingers, zoom) and open a village's stats card.
(function () {
'use strict';
/* ================================================================== drawing kit */

/* ---------- helpers ---------- */
function rng(seed){let a=seed>>>0;return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const hx=h=>{const n=parseInt(h.slice(1),16);return[n>>16,n>>8&255,n&255];};
const sh=(h,f)=>'rgb('+hx(h).map(v=>clamp(v*f,0,255)|0).join(',')+')';
const reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* projection factory: world units → screen */
function proj(ox,oy,k){return (x,y,z=0)=>[ox+(x-y)*k,oy+(x+y)*k*0.5-z*k];}
function poly(ctx,pts,fill,stroke,lw){ctx.beginPath();ctx.moveTo(pts[0][0],pts[0][1]);for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i][0],pts[i][1]);ctx.closePath();if(fill){ctx.fillStyle=fill;ctx.fill();}if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=lw||1;ctx.stroke();}}
function blob(P,cx,cy,r,seed,n=28){const pts=[];for(let i=0;i<n;i++){const a=i/n*6.283;const rr=r*(1+0.13*Math.sin(3*a+seed)+0.08*Math.sin(5*a+seed*2.3));pts.push(P(cx+Math.cos(a)*rr,cy+Math.sin(a)*rr));}return pts;}
function line(ctx,P,pts,w,col,k,dash){ctx.beginPath();pts.forEach((p,i)=>{const s=P(p[0],p[1]);i?ctx.lineTo(s[0],s[1]):ctx.moveTo(s[0],s[1]);});ctx.strokeStyle=col;ctx.lineWidth=w*k;ctx.lineCap='round';ctx.lineJoin='round';ctx.setLineDash(dash||[]);ctx.stroke();ctx.setLineDash([]);}
function curve(a,b,bend,n=20){const mx=(a[0]+b[0])/2,my=(a[1]+b[1])/2,dx=b[0]-a[0],dy=b[1]-a[1];const cx=mx-dy*bend,cy=my+dx*bend;const out=[];for(let i=0;i<=n;i++){const t=i/n;out.push([(1-t)*(1-t)*a[0]+2*(1-t)*t*cx+t*t*b[0],(1-t)*(1-t)*a[1]+2*(1-t)*t*cy+t*t*b[1]]);}return out;}

/* ---------- 3D-ish primitives ---------- */
function box(ctx,P,x,y,w,d,h,col,z0=0,o={}){
  const Au=P(x,y,z0+h),Bu=P(x+w,y,z0+h),Cu=P(x+w,y+d,z0+h),Du=P(x,y+d,z0+h),B=P(x+w,y,z0),C=P(x+w,y+d,z0),D=P(x,y+d,z0);
  poly(ctx,[D,C,Cu,Du],sh(col,0.9),o.edge,0.6);poly(ctx,[B,C,Cu,Bu],sh(col,0.72),o.edge,0.6);if(!o.noTop)poly(ctx,[Au,Bu,Cu,Du],o.top||col,o.edge,0.6);
  return{D,C,B,h,z0};
}
function faceQuad(f,face,u0,u1,v0,v1,k){const a=face==='L'?f.D:f.B,b=f.C,H=f.h*k;const p=(u,v)=>[a[0]+(b[0]-a[0])*u,a[1]+(b[1]-a[1])*u-v*H];return[p(u0,v0),p(u1,v0),p(u1,v1),p(u0,v1)];}
function roof(ctx,P,x,y,w,d,h,rh,kind,col){
  const Au=P(x,y,h),Bu=P(x+w,y,h),Cu=P(x+w,y+d,h),Du=P(x,y+d,h),e='rgba(0,0,0,.22)';
  if(kind==='gx'){const R1=P(x,y+d/2,h+rh),R2=P(x+w,y+d/2,h+rh);poly(ctx,[Au,Bu,R2,R1],sh(col,0.68),e,0.6);poly(ctx,[Du,Cu,R2,R1],sh(col,1.04),e,0.6);return R2;}
  if(kind==='gy'){const R1=P(x+w/2,y,h+rh),R2=P(x+w/2,y+d,h+rh);poly(ctx,[Au,Du,R2,R1],sh(col,0.68),e,0.6);poly(ctx,[Bu,Cu,R2,R1],sh(col,0.86),e,0.6);return R2;}
  const M=P(x+w/2,y+d/2,h+rh);poly(ctx,[Au,Bu,M],sh(col,0.68),e,0.6);poly(ctx,[Au,Du,M],sh(col,0.7),e,0.6);poly(ctx,[Du,Cu,M],sh(col,1.04),e,0.6);poly(ctx,[Bu,Cu,M],sh(col,0.86),e,0.6);return M;
}
function gable(ctx,P,x,y,w,d,h,rh,kind,wc){
  if(kind==='gx')poly(ctx,[P(x+w,y,h),P(x+w,y+d,h),P(x+w,y+d/2,h+rh)],sh(wc,0.72),'rgba(0,0,0,.15)',0.6);
  if(kind==='gy')poly(ctx,[P(x,y+d,h),P(x+w,y+d,h),P(x+w/2,y+d,h+rh)],sh(wc,0.9),'rgba(0,0,0,.15)',0.6);
}
function tree(ctx,P,x,y,s,k,kind){const[sx,sy]=P(x,y);const u=k*s;ctx.fillStyle='rgba(0,0,0,.14)';ctx.beginPath();ctx.ellipse(sx,sy,0.7*u,0.35*u,0,0,7);ctx.fill();
  if(kind==='bush'){[['#4f8a44',0,-0.35,0.42],['#5f9a4e',-0.3,-0.25,0.3],['#3f7a3c',0.3,-0.22,0.3]].forEach(([c,dx,dy,r])=>{ctx.fillStyle=c;ctx.beginPath();ctx.arc(sx+dx*u,sy+dy*u,r*u,0,7);ctx.fill();});return;}
  if(kind==='pine'){ctx.fillStyle='#5b4a33';ctx.fillRect(sx-0.08*u,sy-0.4*u,0.16*u,0.4*u);for(let i=0;i<3;i++){const yy=sy-0.4*u-i*0.55*u,ww=(0.75-i*0.18)*u;poly(ctx,[[sx-ww,yy],[sx+ww,yy],[sx,yy-0.9*u]],'#2f6a3e');}return;}
  ctx.strokeStyle='#5b4a33';ctx.lineWidth=0.18*u;ctx.beginPath();ctx.moveTo(sx,sy);ctx.lineTo(sx,sy-1*u);ctx.stroke();
  [['#4f8a44',0,-1.5,0.7],['#5f9a4e',-0.4,-1.25,0.5],['#3f7a3c',0.4,-1.2,0.5],['#6aa556',-0.1,-1.85,0.38]].forEach(([c,dx,dy,r])=>{ctx.fillStyle=c;ctx.beginPath();ctx.arc(sx+dx*u,sy+dy*u,r*u,0,7);ctx.fill();});
}

/* ---------- natural paths: wear map + merged cobbles ---------- */
function h2(i,j){let n=(i*374761393+j*668265263)|0;n=Math.imul(n^(n>>>13),1274126177);return((n^(n>>>16))>>>0)/4294967296;}
function mixRGB(a,b,t){return[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t];}
// Every path adds "foot traffic" to a grid; where paths overlap the wear adds up,
// so junctions and busy stretches become wider and more worn by themselves.
function wearLayer(ctx,P,k,items,o){
  const [x0,y0,x1,y1]=o.bbox,c=o.cell,nx=Math.ceil((x1-x0)/c),ny=Math.ceil((y1-y0)/c);
  const W=new Float32Array(nx*ny);
  const dep=(x,y,rad,amp)=>{const ci=(x-x0)/c,cj=(y-y0)/c,rr=rad/c,r2=Math.ceil(rr*2);
    for(let j=Math.max(0,Math.floor(cj-r2));j<=Math.min(ny-1,Math.ceil(cj+r2));j++)for(let i=Math.max(0,Math.floor(ci-r2));i<=Math.min(nx-1,Math.ceil(ci+r2));i++){
      const d2=((i-ci)**2+(j-cj)**2)/(rr*rr);if(d2<4)W[j*nx+i]+=amp*Math.exp(-d2*1.6)*0.32;}};
  items.forEach(it=>{
    if(it.disk){const[dx,dy,dr]=it.disk;for(let a=0;a<dr;a+=c*1.5)for(let t=0;t<6.283;t+=c*1.5/Math.max(a,c))dep(dx+Math.cos(t)*a,dy+Math.sin(t)*a,c*2,it.amp*1.2);return;}
    const p=it.pts;for(let s=0;s<p.length-1;s++){const ax=p[s][0],ay=p[s][1],bx=p[s+1][0],by=p[s+1][1],L=Math.hypot(bx-ax,by-ay),n=Math.max(1,Math.ceil(L/(c*0.9)));
      for(let q=0;q<n;q++){const u=q/n;dep(ax+(bx-ax)*u,ay+(by-ay)*u,it.w/2,it.amp);}}
  });
  // soften
  const B=new Float32Array(nx*ny);
  for(let pass=0;pass<3;pass++){for(let j=1;j<ny-1;j++)for(let i=1;i<nx-1;i++){let s=0;for(let b=-1;b<=1;b++)for(let a=-1;a<=1;a++)s+=W[(j+b)*nx+i+a];B[j*nx+i]=s/9;}W.set(B);}
  const pal=o.pal||[[190,186,124],[188,172,116],[174,145,94],[146,112,70],[118,90,56]];
  const col=v=>v<0.33?mixRGB(pal[0],pal[1],v/0.33):v<0.6?mixRGB(pal[1],pal[2],(v-0.33)/0.27):v<0.85?mixRGB(pal[2],pal[3],(v-0.6)/0.25):mixRGB(pal[3],pal[4],Math.min(1,(v-0.85)/0.15));
  const buckets=new Map(),puddles=[];
  for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
    let v=1-Math.exp(-W[j*nx+i]*(o.gain||2.2));if(v<0.06)continue;
    v=clamp(v+(h2(i,j)-0.5)*0.07,0,1);if(v<0.1)continue;
    const key=Math.round(v*32);let b=buckets.get(key);if(!b){b=[];buckets.set(key,b);}b.push([i,j]);
    if(o.puddles&&v>0.82&&h2(i*7,j*13)>0.992)puddles.push([x0+i*c,y0+j*c]);
  }
  const e=c*0.08;
  buckets.forEach((cells,key)=>{const v=key/32,cc=col(v);const a=clamp((v-0.1)*4,0,1);
    ctx.fillStyle=`rgba(${cc[0]|0},${cc[1]|0},${cc[2]|0},${a})`;ctx.beginPath();
    cells.forEach(([i,j])=>{const x=x0+i*c-e,y=y0+j*c-e,s=c+2*e;const p1=P(x,y),p2=P(x+s,y),p3=P(x+s,y+s),p4=P(x,y+s);ctx.moveTo(p1[0],p1[1]);ctx.lineTo(p2[0],p2[1]);ctx.lineTo(p3[0],p3[1]);ctx.lineTo(p4[0],p4[1]);ctx.closePath();});
    ctx.fill();});
  puddles.forEach(([x,y])=>{const p=P(x,y);ctx.fillStyle='rgba(120,150,170,.75)';ctx.beginPath();ctx.ellipse(p[0],p[1],0.3*k,0.13*k,0,0,7);ctx.fill();ctx.fillStyle='rgba(255,255,255,.25)';ctx.beginPath();ctx.ellipse(p[0]-0.08*k,p[1]-0.03*k,0.1*k,0.04*k,0,0,7);ctx.fill();});
}
// Cobbled roads and squares as ONE shape: all edges first, then all surfaces,
// then a single stone pattern fixed to the ground, so stones run on through joins.
function cobbleUnion(ctx,P,k,strokes,blobs){
  // Cobbled roads and squares as ONE shape, drawn straight onto the visible canvas:
  // edges first, then the road area is used as a clip and one stone pattern fixed to the
  // ground is laid inside it. No helper canvas and nothing copied between canvases,
  // so browser privacy shields (e.g. Brave's canvas protection) can't get in the way.
  let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;const grow=p=>{x0=Math.min(x0,p[0]);y0=Math.min(y0,p[1]);x1=Math.max(x1,p[0]);y1=Math.max(y1,p[1]);};
  strokes.forEach(s=>s.pts.forEach(grow));blobs.forEach(b=>b.forEach(grow));
  if(x0>x1)return;
  strokes.forEach(s=>line(ctx,P,s.pts,s.w+0.22,'#867f70',k));
  blobs.forEach(b=>poly(ctx,b.map(p=>P(p[0],p[1])),null,'#867f70',0.22*k));
  const area=pts=>{let a=0;for(let i=0;i<pts.length;i++){const p=pts[i],q=pts[(i+1)%pts.length];a+=p[0]*q[1]-q[0]*p[1];}return a;};
  const sub=pts=>{if(area(pts)<0)pts=pts.slice().reverse();const s=pts.map(p=>P(p[0],p[1]));ctx.moveTo(s[0][0],s[0][1]);for(let i=1;i<s.length;i++)ctx.lineTo(s[i][0],s[i][1]);ctx.closePath();};
  ctx.save();ctx.beginPath();
  strokes.forEach(s=>{const h=s.w/2,p=s.pts;
    for(let i=0;i<p.length-1;i++){const a=p[i],b=p[i+1],dx=b[0]-a[0],dy=b[1]-a[1],l=Math.hypot(dx,dy)||1,nx=-dy/l*h,ny=dx/l*h;sub([[a[0]+nx,a[1]+ny],[b[0]+nx,b[1]+ny],[b[0]-nx,b[1]-ny],[a[0]-nx,a[1]-ny]]);}
    p.forEach(c=>{const ring=[];for(let j=0;j<12;j++){const t=j/12*6.283;ring.push([c[0]+Math.cos(t)*h,c[1]+Math.sin(t)*h]);}sub(ring);});});
  blobs.forEach(b=>sub(b));
  ctx.clip('nonzero');
  const corners=[P(x0-1,y0-1),P(x1+1,y0-1),P(x1+1,y1+1),P(x0-1,y1+1)];
  poly(ctx,corners,'#b3ad9f');
  const g=0.26;
  for(let y=Math.floor((y0-1)/g)*g;y<y1+1;y+=g)for(let x=Math.floor((x0-1)/g)*g;x<x1+1;x+=g){const i=Math.round(x/g),j=Math.round(y/g);const ox=(j%2)*g/2;const r=h2(i,j);
    const q=[P(x+ox+0.02,y+0.02),P(x+ox+g-0.03,y+0.02),P(x+ox+g-0.03,y+g-0.03),P(x+ox+0.02,y+g-0.03)];
    poly(ctx,q,r<0.33?'#a39c8d':r<0.66?'#bbb5a7':'#aea89a');}
  ctx.restore();
}
// older browsers: roundRect for labels and badges
if(typeof CanvasRenderingContext2D!=='undefined'&&!CanvasRenderingContext2D.prototype.roundRect){CanvasRenderingContext2D.prototype.roundRect=function(x,y,w,h,r){r=Math.min(r,w/2,h/2);this.moveTo(x+r,y);this.arcTo(x+w,y,x+w,y+h,r);this.arcTo(x+w,y+h,x,y+h,r);this.arcTo(x,y+h,x,y,r);this.arcTo(x,y,x+w,y,r);this.closePath();};}
function circlePts(cx,cy,r,seed,n=28){const out=[];for(let i=0;i<n;i++){const a=i/n*6.283;const rr=r*(1+0.06*Math.sin(3*a+seed));out.push([cx+Math.cos(a)*rr,cy+Math.sin(a)*rr]);}return out;}
let MODE='new';

/* ---------- town model ---------- */
const STEPS=[
  ['Būdiņa','Viena būdiņa uz iemītas zāles, blakus dubļu pleķītis un krūms.'],
  ['Māja ar palīgēku','Lielāka māja un šķūnītis, starp tām iemītas taciņas, malkas grēda.'],
  ['Koka žogs','Žogs ap teritoriju, vairākas ēkas ar skursteņiem un dūmiem, dārziņš.'],
  ['Aka un pagalms','Centrā aka, taciņas kļūst par zemes ceļiņiem.'],
  ['Lauki aiz žoga','Vairāk māju, siena kaudzes un lauki ārpus žoga.'],
  ['Galvenā ēka','Kāršu zāle vai teātris, pirmās divstāvu mājas, pirmie iedzīvotāji.'],
  ['Palisāde un vārti','Augstāks žogs ar vārtiem, galvenie ceļi kļūst grantēti.'],
  ['Bruģēts laukums','Bruģēts centrs, tirgus teltis, laternas, vairāk cilvēku.'],
  ['Piemineklis','Mājas cieši ap laukumu, piemineklis, akmens vārtu torņi.'],
  ['Pilsētiņa','Akmens mūris ar torni, dzīva miniatūra pilsētiņa.']
];
const COUNT=[1,2,4,6,8,11,14,18,23,28];
const PEOPLE=[0,0,0,1,2,3,5,7,10,14];
const FENCE=[0,0,4.6,5.2,6.0,7.0,8.0,8.6,9.2,9.8];
function buildTown(L,seed,game){
  const R=rng(seed);
  const T={L,game,items:[],paths:[],chimneys:[],doors:[],walkPaths:[],fenceR:FENCE[L-1]};
  // building slots in rings around the centre, stable for a given seed
  const slots=[];
  slots.push({x:-1.9,y:-1.5,ring:0}); // first home
  slots.push({x:0.4,y:-2.6,ring:0});  // shed
  const ring=(r,n,off)=>{for(let i=0;i<n;i++){const a=off+i/n*6.283+(R()-0.5)*0.25;slots.push({x:Math.cos(a)*r*(0.92+R()*0.16),y:Math.sin(a)*r*(0.92+R()*0.16),ring:r});}};
  ring(3.4,6,0.4);ring(5.4,10,0.15);ring(7.3,14,0.3);
  // main building gets a fixed slot facing the square
  const mainSlot={x:2.6,y:-0.9};
  const isD=game==='d';
  const thatch=['#c9a85a','#b8954a','#d1b26a'],shingle=['#8a6a4a','#7a5a3a','#6e5642'];
  const tiles=isD?['#2f7391','#b58a3c','#3d5a6b','#245a73']:['#a8323e','#b8553a','#7d2430','#c24b55'];
  const roofFor=(i)=>L<=3?thatch[i%3]:L<=6?(i%3===0?tiles[i%4]:shingle[i%3]):(i%5===0?shingle[i%3]:tiles[i%4]);
  const wallFor=(i)=>L<=2?'#a9825a':L<=5?(i%2?'#c49a6c':'#efe4c9'):['#efe4c9','#e8d9b5','#f3ead6','#d9c3a0'][i%4];
  const n=COUNT[L-1];
  let placed=0;
  for(let i=0;i<slots.length&&placed<n;i++){
    const s=slots[i];
    if(L>=6&&Math.hypot(s.x-mainSlot.x,s.y-mainSlot.y)<2.2)continue;
    if(s.ring&&FENCE[L-1]&&Math.hypot(s.x,s.y)>FENCE[L-1]-0.9)continue;
    let w,d,h,rh,kind='house';
    if(i===0){ if(L===1){w=0.95;d=0.85;h=0.55;rh=0.55;kind='hut';} else {w=1.5;d=1.2;h=0.8;rh=0.75;} }
    else if(i===1){w=0.8;d=0.7;h=0.55;rh=0.4;kind='shed';}
    else{const two=L>=6&&s.ring<=3.4&&R()<0.6;w=1+R()*0.45;d=0.9+R()*0.35;h=two?1.35:0.8;rh=0.6+R()*0.2;}
    const roofK=kind==='shed'?'gy':(R()<0.5?'gx':'gy');
    T.items.push({k:kind,x:s.x-w/2,y:s.y-d/2,w,d,h,rh,roof:roofK,rc:roofFor(i),wc:kind==='shed'?'#8f6f4a':wallFor(i),chim:L>=3&&kind!=='shed'&&(i===0||R()<0.7)});
    placed++;
  }
  if(L>=6)T.items.push({k:isD?'hall':'theatre',x:mainSlot.x-1.1,y:mainSlot.y-1,w:2.2,d:2});
  // centre features
  if(L>=4)T.items.push({k:'well',x:0,y:0});
  if(L>=8){[[-1.2,1.2],[1.3,1.1],[-1.3,-0.4],[0.2,1.6]].slice(0,L>=9?4:3).forEach(([x,y],i)=>T.items.push({k:'stall',x,y,c:i%2}));}
  if(L>=9)T.items.push({k:'statue',x:-0.2,y:-1.3});
  if(L>=10)T.items.push({k:'tower',x:-FENCE[9]*0.72,y:-FENCE[9]*0.72});
  // small things
  if(L<=3){T.mud={x:-0.4,y:-0.3,r:0.55};}
  T.items.push({k:'bush',x:-3.1,y:-0.4});
  if(L>=2)T.items.push({k:'wood',x:-0.9,y:-2.9});
  if(L>=3)T.garden={x:-4.1,y:1.0};
  // trees outside
  const fr=Math.max(3.6,FENCE[L-1]);
  for(let i=0;i<14;i++){const a=R()*6.283,r=fr+1.2+R()*3.5;T.items.push({k:R()<0.35?'pine':'tree',x:Math.cos(a)*r,y:Math.sin(a)*r,s:0.8+R()*0.5});}
  if(L>=5)for(let i=0;i<3;i++){const a=0.8+i*0.5,r=fr+1.6;T.items.push({k:'hay',x:Math.cos(a)*r,y:Math.sin(a)*r});}
  if(L>=5)T.fields=[[fr+2.2,1.1],[fr+2.0,2.0]];
  // gates on the four axes from step 7
  T.gates=L>=7;
  // OLD paths ("stickers"): a separate line from the centre to every door
  const centre=[0,0];
  const blds=T.items.filter(it=>['house','hut','shed','hall','theatre'].includes(it.k));
  T.pathsOld=[];
  blds.forEach(it=>{const door=[it.x+it.w/2,it.y+it.d+0.15];T.doors.push(door);T.pathsOld.push(curve(L>=4?centre:[-1.15,-0.25],door,(R()-0.5)*0.35));});
  if(L>=3)[[0,1],[1,0],[0,-1],[-1,0]].forEach(([dx,dy])=>T.pathsOld.push(curve(centre,[dx*(FENCE[L-1]+1.3),dy*(FENCE[L-1]+1.3)],0.05)));
  // NEW paths: a network. Main exits first; every door then joins the NEAREST
  // point of the paths already there, so paths branch instead of fanning out.
  const R2=rng(seed*3+L);
  const hub=L>=4?centre:[blds[0].x+blds[0].w/2,blds[0].y+blds[0].d+0.5];
  const net=[];
  if(L>=3)[[0,1],[1,0],[0,-1],[-1,0]].forEach(([dx,dy])=>net.push({pts:curve(hub,[dx*(FENCE[L-1]+1.3),dy*(FENCE[L-1]+1.3)],(R2()-0.5)*0.08,18),main:true}));
  const sorted=blds.map(it=>({it,door:[it.x+it.w/2,it.y+it.d+0.12]})).sort((a,b)=>Math.hypot(a.door[0]-hub[0],a.door[1]-hub[1])-Math.hypot(b.door[0]-hub[0],b.door[1]-hub[1]));
  sorted.forEach(({door},n)=>{
    if(L<4&&n===0)return; // the first home is the hub itself
    const out=[door[0],door[1]+0.4];
    let best=hub,bd=Math.hypot(out[0]-hub[0],out[1]-hub[1]);
    net.forEach(p=>p.pts.forEach(q=>{const d=Math.hypot(q[0]-out[0],q[1]-out[1]);if(d<bd){bd=d;best=q;}}));
    net.push({pts:[door].concat(curve(out,best,(R2()-0.5)*0.3,10)),main:false});
  });
  T.paths=net;
  net.forEach(p=>T.walkPaths.push(p.pts));
  return T;
}
function pathStyle(L){return L<=3?{w:0.3,c:'rgba(214,200,130,.75)'}:L<=6?{w:0.42,c:'#a88458'}:{w:0.55,c:'#a9a499',cob:true};}
function feats(T){const L=T.L,f=[];
  f.push(`${COUNT[L-1]} ${COUNT[L-1]===1?'ēka':'ēkas'}${L>=6?' + '+(T.game==='d'?'kāršu zāle':'teātris'):''}`);
  f.push(L<=3?'Jumti: salmi':L<=6?'Jumti: koka skaidas':`Jumti: dakstiņi ${T.game==='d'?'petrol un zeltā':'sarkanos toņos'}`);
  f.push(L<=1?'Iemīta zāle, dubļu pleķītis, krūms':L<=3?'Iemītas taciņas starp ēkām':L<=6?'Zemes ceļiņi':'Galvenie ceļi bruģēti');
  if(L>=3&&L<=6)f.push('Koka žogs');if(L>=7&&L<=9)f.push('Palisāde ar vārtiem');if(L>=10)f.push('Akmens mūris un tornis');
  if(L>=3)f.push('Skursteņi ar dūmiem');if(PEOPLE[L-1])f.push(`${PEOPLE[L-1]} iedzīvotāji kustībā`);
  return f;}

/* ---------- town drawing ---------- */
function drawTown(ctx,P,k,T,opts={}){
  const L=T.L,fr=T.fenceR;
  const R=rng(7+L);
  // worn ground
  const wornR=L===1?1.5:L===2?2.7:Math.max(3.2,fr-0.2);
  poly(ctx,blob(P,L<=2?-1.2:0,L<=2?-1.2:0,wornR+0.35,1.3),'rgba(170,190,110,.45)');
  poly(ctx,blob(P,L<=2?-1.2:0,L<=2?-1.2:0,wornR,2.1),L<=3?'#a9b974':'#b3b383');
  // fields + garden
  (T.fields||[]).forEach(([r,a],i)=>{const cx=Math.cos(a)*r,cy=Math.sin(a)*r;const pts=[P(cx-1,cy-0.8),P(cx+1,cy-0.8),P(cx+1,cy+0.8),P(cx-1,cy+0.8)];poly(ctx,pts,i?'#d8c36d':'#9cbf62');ctx.strokeStyle='rgba(80,90,40,.35)';ctx.lineWidth=1;for(let j=1;j<6;j++){const a1=P(cx-1+j/3,cy-0.8),b1=P(cx-1+j/3,cy+0.8);ctx.beginPath();ctx.moveTo(a1[0],a1[1]);ctx.lineTo(b1[0],b1[1]);ctx.stroke();}});
  if(T.garden){const g=T.garden;poly(ctx,[P(g.x-0.7,g.y-0.6),P(g.x+0.7,g.y-0.6),P(g.x+0.7,g.y+0.6),P(g.x-0.7,g.y+0.6)],'#7a5a3a');ctx.strokeStyle='#5f9a4e';ctx.lineWidth=0.14*k;for(let j=0;j<4;j++){const a1=P(g.x-0.55,g.y-0.45+j*0.3),b1=P(g.x+0.55,g.y-0.45+j*0.3);ctx.beginPath();ctx.moveTo(a1[0],a1[1]);ctx.lineTo(b1[0],b1[1]);ctx.stroke();}}
  if(MODE==='old'){
    // square
    if(L>=4){poly(ctx,blob(P,0,0,L>=8?2.3:1.5,4.2,22),L>=8?'#bdb6a6':'#b49a6e');
      if(L>=8){ctx.fillStyle='rgba(90,85,75,.28)';for(let i=0;i<70;i++){const a=R()*6.28,r=Math.sqrt(R())*2.1;const p=P(Math.cos(a)*r,Math.sin(a)*r);ctx.fillRect(p[0]-0.12*k,p[1]-0.05*k,0.24*k,0.1*k);}}}
    // paths drawn one by one: edges of later paths land on earlier ones
    const st=pathStyle(L);
    T.pathsOld.forEach(p=>{line(ctx,P,p,st.w+0.12,'rgba(0,0,0,.08)',k);line(ctx,P,p,st.w,st.c,k);if(st.cob){line(ctx,P,p,st.w*0.75,'rgba(90,85,75,.22)',k,[0.12*k,0.18*k]);}});
  }else{
    const wear=[];
    T.paths.forEach(p=>wear.push({pts:p.pts,w:L<=3?0.38:(p.main&&L>=7?1.25:0.5),amp:L<=3?0.5:(p.main?(L>=7?0.5:0.7):0.55)}));
    if(L>=4)wear.push({disk:[0,0,L>=8?2.6:1.5],amp:L>=8?0.5:0.85});
    if(T.mud)wear.push({disk:[T.mud.x,T.mud.y,0.8],amp:0.7});
    wearLayer(ctx,P,k,wear,{bbox:[-12,-12,12,12],cell:opts.cell||0.1,puddles:L>=4&&L<=6});
    if(L>=7){const strokes=T.paths.filter(p=>p.main).map(p=>({pts:p.pts,w:L>=9?0.8:0.66}));cobbleUnion(ctx,P,k,strokes,L>=8?[circlePts(0,0,2.3,4.2)]:[]);}
  }
  // mud patch
  if(T.mud){const m=T.mud;poly(ctx,blob(P,m.x,m.y,m.r,5.5,18),'#7a5a38');poly(ctx,blob(P,m.x+0.1,m.y+0.05,m.r*0.45,9.1,14),'rgba(120,150,170,.65)');}
  // fence (back half before items, front half after) — draw as posts sorted with items
  const items=T.items.slice();
  if(fr){const nposts=Math.round(fr*7);const kind=L<=6?'fence':L<=9?'palisade':'stone';
    for(let i=0;i<nposts;i++){const a=i/nposts*6.283;const x=Math.cos(a)*fr,y=Math.sin(a)*fr;
      const gate=T.gates&&[0,Math.PI/2,Math.PI,Math.PI*1.5].some(g=>Math.abs(((a-g+9.42)%6.283)-3.14)<0.13*(9/fr));
      items.push({k:gate?'gap':kind,x,y,a,next:[Math.cos(a+6.283/nposts)*fr,Math.sin(a+6.283/nposts)*fr]});}
    if(T.gates&&L>=9){[0,Math.PI/2,Math.PI,Math.PI*1.5].forEach(g=>{[-0.16,0.16].forEach(o=>items.push({k:'gtower',x:Math.cos(g+o*(9/fr))*fr,y:Math.sin(g+o*(9/fr))*fr}));});}
  }
  items.sort((a,b)=>((a.x+(a.w||0)/2)+(a.y+(a.d||0)/2))-((b.x+(b.w||0)/2)+(b.y+(b.d||0)/2)));
  T.chimneys=[];
  items.forEach(it=>{
    switch(it.k){
      case 'tree':case 'pine':case 'bush':tree(ctx,P,it.x,it.y,it.s||1,k,it.k);break;
      case 'hay':{const[sx,sy]=P(it.x,it.y);ctx.fillStyle='rgba(0,0,0,.14)';ctx.beginPath();ctx.ellipse(sx,sy,0.5*k,0.25*k,0,0,7);ctx.fill();ctx.fillStyle='#d9bf68';ctx.beginPath();ctx.ellipse(sx,sy-0.3*k,0.42*k,0.4*k,0,Math.PI,0);ctx.lineTo(sx+0.42*k,sy);ctx.lineTo(sx-0.42*k,sy);ctx.fill();break;}
      case 'wood':{for(let r=0;r<3;r++)for(let c=0;c<3-r;c++){const[sx,sy]=P(it.x+c*0.18+r*0.09,it.y,0.12+r*0.16);ctx.fillStyle='#8a6440';ctx.beginPath();ctx.arc(sx,sy,0.09*k,0,7);ctx.fill();ctx.fillStyle='#c9a06a';ctx.beginPath();ctx.arc(sx,sy,0.05*k,0,7);ctx.fill();}break;}
      case 'hut':case 'house':case 'shed':{
        const f=box(ctx,P,it.x,it.y,it.w,it.d,it.h,it.wc,0,{noTop:true,edge:'rgba(0,0,0,.14)'});
        if(it.k==='hut'||L<=2){ctx.strokeStyle='rgba(70,45,25,.35)';ctx.lineWidth=0.7;for(let j=1;j<4;j++){const q=faceQuad(f,'L',0,1,j/4,j/4,k);ctx.beginPath();ctx.moveTo(q[0][0],q[0][1]);ctx.lineTo(q[1][0],q[1][1]);ctx.stroke();}}
        if(it.k!=='shed'){const two=it.h>1.1;(two?[0.15,0.6]:[0.35]).forEach(v=>{[0.15,0.68].forEach(u=>poly(ctx,faceQuad(f,'L',u,u+0.17,v,v+(two?0.2:0.3),k),'#3b4a55','rgba(255,255,255,.35)',0.6));poly(ctx,faceQuad(f,'R',0.38,0.6,v,v+(two?0.2:0.3),k),'#3b4a55','rgba(255,255,255,.35)',0.6);});}
        poly(ctx,faceQuad(f,'L',0.42,0.58,0,it.k==='shed'?0.8:(it.h>1.1?0.38:0.6),k),it.k==='shed'?'#5e4630':'#5a4632');
        gable(ctx,P,it.x,it.y,it.w,it.d,it.h,it.rh,it.roof,it.wc);
        roof(ctx,P,it.x-0.06,it.y-0.06,it.w+0.12,it.d+0.12,it.h,it.rh,it.roof,it.rc);
        if(it.chim){const cx=it.x+it.w*0.68,cy=it.y+it.d*0.3;box(ctx,P,cx,cy,0.14,0.14,it.rh*0.85,'#8a6a55',it.h,{top:'#4a3a30'});T.chimneys.push(P(cx+0.07,cy+0.07,it.h+it.rh*0.85+0.05));}
        break;}
      case 'hall':case 'theatre':{const isH=it.k==='hall',h=1.45,wc=isH?'#f6eedb':'#f3e6d0';
        const f=box(ctx,P,it.x,it.y,it.w,it.d,h,wc,0,{noTop:!isH?false:true,top:'#d8c8a8',edge:'rgba(0,0,0,.15)'});
        for(let i=0;i<4;i++)poly(ctx,faceQuad(f,'L',0.08+i*0.23,0.2+i*0.23,0.4,0.72,k),'#3b4a55','rgba(255,255,255,.35)',0.6);
        poly(ctx,faceQuad(f,'L',0.42,0.58,0,0.36,k),'#5a4632');
        const pl=faceQuad(f,'L',0.36,0.64,0.78,0.97,k);poly(ctx,pl,isH?'#2f7391':'#7d2430','#e2c374',1);const m=[(pl[0][0]+pl[2][0])/2,(pl[0][1]+pl[2][1])/2];ctx.fillStyle='#e2c374';ctx.font=`bold ${0.42*k}px Georgia`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(isH?'♠':'♥',m[0],m[1]+1);
        if(isH){gable(ctx,P,it.x,it.y,it.w,it.d,h,0.9,'gx',wc);roof(ctx,P,it.x-0.06,it.y-0.06,it.w+0.12,it.d+0.12,h,0.9,'gx','#2f7391');T.chimneys.push(P(it.x+1.6,it.y+0.6,h+0.95));}
        else{const c=P(it.x+it.w/2,it.y+it.d/2,h);const r=1.15*k;ctx.fillStyle='#a8323e';ctx.beginPath();ctx.ellipse(c[0],c[1],r,r*0.5,0,0,Math.PI);ctx.arc(c[0],c[1],r,0,Math.PI,true);ctx.fill();ctx.fillStyle='rgba(255,255,255,.15)';ctx.beginPath();ctx.arc(c[0]-0.3*k,c[1]-0.4*k,r*0.5,Math.PI*1.1,Math.PI*1.6);ctx.lineTo(c[0]-0.3*k,c[1]-0.4*k);ctx.fill();ctx.fillStyle='#e2c374';ctx.fillRect(c[0]-1.5,c[1]-r-0.35*k,3,0.35*k);}
        break;}
      case 'well':{box(ctx,P,-0.22,-0.22,0.44,0.44,0.3,'#9a958a',0,{top:'#3b6f8a'});const a=P(-0.18,0,0.3),b=P(0.18,0,0.3);ctx.strokeStyle='#5b4a33';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(a[0],a[1]-0.55*k);ctx.moveTo(b[0],b[1]);ctx.lineTo(b[0],b[1]-0.55*k);ctx.stroke();roof(ctx,P,-0.3,-0.3,0.6,0.6,0.8,0.3,'hip','#7a5a36');break;}
      case 'stall':{box(ctx,P,it.x-0.3,it.y-0.25,0.6,0.5,0.28,'#9a7448',0,{top:'#b58a5a'});roof(ctx,P,it.x-0.36,it.y-0.3,0.72,0.6,0.75,0.28,'hip',it.c?'#2f7391':'#a8323e');break;}
      case 'statue':{box(ctx,P,it.x-0.18,it.y-0.18,0.36,0.36,0.35,'#b8b3a6',0,{top:'#cfcabe'});const p=P(it.x,it.y,0.35);ctx.fillStyle='#c9a24b';ctx.fillRect(p[0]-0.08*k,p[1]-0.5*k,0.16*k,0.5*k);ctx.beginPath();ctx.arc(p[0],p[1]-0.58*k,0.12*k,0,7);ctx.fill();break;}
      case 'tower':{box(ctx,P,it.x-0.5,it.y-0.5,1,1,2.8,'#b9b4a8',0,{top:'#a19c90',edge:'rgba(0,0,0,.15)'});for(let i=0;i<3;i++){box(ctx,P,it.x-0.5+i*0.38,it.y+0.32,0.18,0.18,0.25,'#b9b4a8',2.8);box(ctx,P,it.x+0.32,it.y-0.5+i*0.38,0.18,0.18,0.25,'#b9b4a8',2.8);}const p=P(it.x,it.y,2.8);ctx.strokeStyle='#4a3a26';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(p[0],p[1]);ctx.lineTo(p[0],p[1]-0.9*k);ctx.stroke();poly(ctx,[[p[0],p[1]-0.9*k],[p[0]+0.5*k,p[1]-0.75*k],[p[0],p[1]-0.6*k]],'#c9a24b');break;}
      case 'gtower':box(ctx,P,it.x-0.3,it.y-0.3,0.6,0.6,1.3,'#b9b4a8',0,{top:'#a19c90',edge:'rgba(0,0,0,.12)'});break;
      case 'fence':case 'palisade':case 'stone':{
        const h=it.k==='fence'?0.4:it.k==='palisade'?0.75:0.65,col=it.k==='stone'?'#b9b4a8':it.k==='palisade'?'#7d5c3a':'#9a7448';
        const a=P(it.x,it.y),b=P(it.next[0],it.next[1]);
        if(it.k==='stone'){const a2=P(it.x,it.y,h),b2=P(it.next[0],it.next[1],h);poly(ctx,[a,b,b2,a2],sh(col,0.82),'rgba(0,0,0,.12)',0.6);ctx.strokeStyle=sh(col,1.1);ctx.lineWidth=0.12*k;ctx.beginPath();ctx.moveTo(a2[0],a2[1]);ctx.lineTo(b2[0],b2[1]);ctx.stroke();}
        else{ctx.strokeStyle=sh(col,0.75);ctx.lineWidth=(it.k==='palisade'?0.14:0.08)*k;ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(a[0],a[1]-h*k);ctx.stroke();
          if(it.k==='fence'){ctx.lineWidth=0.06*k;ctx.strokeStyle=col;[0.18,0.32].forEach(z=>{ctx.beginPath();ctx.moveTo(a[0],a[1]-z*k);ctx.lineTo(b[0],b[1]-z*k);ctx.stroke();});}
          else{ctx.fillStyle=sh(col,0.9);const a2=P(it.x,it.y,h),b2=P(it.next[0],it.next[1],h);poly(ctx,[a,b,b2,a2],sh(col,0.85));ctx.strokeStyle='rgba(0,0,0,.18)';ctx.lineWidth=0.6;ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(a2[0],a2[1]);ctx.stroke();}}
        break;}
    }
  });
}

function person(ctx,p,col,k){ctx.fillStyle='rgba(0,0,0,.2)';ctx.beginPath();ctx.ellipse(p[0],p[1],0.14*k,0.06*k,0,0,7);ctx.fill();ctx.fillStyle=col;ctx.fillRect(p[0]-0.07*k,p[1]-0.3*k,0.14*k,0.26*k);ctx.fillStyle='#f1d9bd';ctx.beginPath();ctx.arc(p[0],p[1]-0.37*k,0.075*k,0,7);ctx.fill();}
function along(path,t){const n=path.length-1,f=clamp(t,0,1)*n,i=Math.min(n-1,f|0),u=f-i;return[path[i][0]+(path[i+1][0]-path[i][0])*u,path[i][1]+(path[i+1][1]-path[i][1])*u];}

function drawRoad(ctx,P,k,pts,q,seed){
  if(q===0)return;
  const R=rng(seed);
  if(q===1){line(ctx,P,pts,0.95,'rgba(190,200,120,.35)',k);line(ctx,P,pts,0.55,'rgba(214,205,140,.75)',k,[0.6*k,0.25*k]);return;}
  if(q===2){line(ctx,P,pts,1.25,'rgba(80,60,30,.18)',k);line(ctx,P,pts,1.0,'#8a6a42',k);
    // ruts and puddles
    const off=(d)=>pts.map((p,i)=>{const a=pts[Math.max(0,i-1)],b=pts[Math.min(pts.length-1,i+1)];const dx=b[0]-a[0],dy=b[1]-a[1],l=Math.hypot(dx,dy)||1;return[p[0]-dy/l*d,p[1]+dx/l*d];});
    line(ctx,P,off(0.22),0.1,'rgba(60,40,20,.45)',k);line(ctx,P,off(-0.22),0.1,'rgba(60,40,20,.45)',k);
    for(let i=2;i<pts.length-2;i+=3){if(R()<0.6){const p=P(pts[i][0]+(R()-0.5)*0.3,pts[i][1]+(R()-0.5)*0.3);ctx.fillStyle='rgba(120,150,170,.7)';ctx.beginPath();ctx.ellipse(p[0],p[1],0.35*k,0.15*k,0,0,7);ctx.fill();}}
    return;}
  line(ctx,P,pts,1.55,'rgba(60,55,45,.25)',k);line(ctx,P,pts,1.35,'#8f8a7e',k);line(ctx,P,pts,1.15,'#b3ad9f',k);
  line(ctx,P,pts,1.0,'rgba(90,85,75,.35)',k,[0.16*k,0.14*k]);line(ctx,P,pts,0.5,'rgba(90,85,75,.25)',k,[0.12*k,0.2*k]);
}
function naturalRoads(c,P,k,roads,bbox,cell){
  const wear=[];
  roads.forEach(r=>{if(!r.q)return;const amp=[0,0.17,0.95,0.55][r.q],w=[0,0.95,1.2,1.9][r.q];wear.push({pts:r.pts,w,amp});});
  wearLayer(c,P,k,wear,{bbox,cell,puddles:true,gain:2.4});
  const cob=roads.filter(r=>r.q===3).map(r=>({pts:r.pts,w:1.15}));
  if(cob.length)cobbleUnion(c,P,k,cob,[]);
}
/* ================================================================== live map */
// Everything below draws what /api/world says (platform/world.js): the villages around the
// part of the world being looked at, roads worn by the games played between players, walkers
// for games in progress, smoke for players online, bunting for tournament hosts.
//
// Moving around: drag with the mouse (desktop) or two fingers (phones — one finger keeps
// scrolling the page), zoom with the +/− buttons, a trackpad pinch or a two-finger pinch.
// While moving, the already drawn ground canvas only slides/scales (CSS transform); it is
// drawn again once when the gesture ends. The ground canvas is bigger than the screen by a
// margin on every side, so an ordinary drag only reveals ground that is already drawn.
MODE = 'new';
const API = '/api/world';
const POLL_MS = 10000;
const K_MIN = 4.5, K_MAX = 20;

// Every village sits on its own place of a hex grid. The spacing is sized for the BIGGEST
// possible village (level 10: stone wall radius ~9.8, gate towers) plus room for a road
// between neighbours, so villages never overlap however much they grow.
const R_MAX = 10.4, ROAD_GAP = 4.2, D = 2 * R_MAX + ROAD_GAP, HROW = D * 0.866;
const hexXY = (h) => ({ x: D * (h.q + h.r / 2), y: HROW * h.r });
function xyHex(x, y) {
  // nearest hex to a ground point (cube rounding)
  const r = y / HROW, q = x / D - r / 2, s = -q - r;
  let rq = Math.round(q), rr = Math.round(r), rs = Math.round(s);
  const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs; else if (dr > ds) rr = -rq - rs;
  return { q: rq, r: rr };
}
const hexDist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
const quality = (n) => (n >= 100 ? 3 : n >= 25 ? 2 : n >= 5 ? 1 : 0);
const ROAD_NAMES = ['', 'iemītu taciņu', 'dubļainu taciņu', 'bruģētu ceļu'];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nameHash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % 100000 + 1; };
const plural = (n, one, many) => n + ' ' + (n % 10 === 1 && n % 100 !== 11 ? one : many);
const site = () => (window.UzsSite ? window.UzsSite.state() : { me: null, known: null });

let VIEW = 'guest';
let TOWNS = [], PLOT = null, PAIRS = [], HOME = null, EXTENT = 2, MINE = null;
const townsBy = new Map(); // name -> town (everything seen so far while moving around)
const pairsBy = new Map(); // "a\u0001b" -> games played between them
let reqCenter = null; // hex the last data was asked for
let baseSig = '';

// Routes go AROUND every village that isn't the start or the goal (and around the free plot):
// the straight line is pushed out past each circle it would cut, then smoothed.
// Roads may still cross each other.
function planRoute(A, B, skip) {
  const near = (o) => Math.hypot(o.x - (A.x + B.x) / 2, o.y - (A.y + B.y) / 2) < Math.hypot(A.x - B.x, A.y - B.y) / 2 + R_MAX * 2;
  const obs = TOWNS.map((t, i) => ({ x: t.x, y: t.y, r: R_MAX + 1.2, i })).filter((o) => !skip.includes(o.i) && near(o));
  if (PLOT) obs.push({ x: PLOT.x, y: PLOT.y, r: R_MAX + 1.2, i: -1 });
  let pts = [[A.x, A.y], [B.x, B.y]];
  for (let it = 0; it < 12; it++) {
    let changed = false;
    for (let s = 0; s < pts.length - 1 && !changed; s++) {
      const p = pts[s], q = pts[s + 1], dx = q[0] - p[0], dy = q[1] - p[1], L2 = dx * dx + dy * dy || 1;
      for (const o of obs) {
        const u = ((o.x - p[0]) * dx + (o.y - p[1]) * dy) / L2;
        if (u <= 0.02 || u >= 0.98) continue;
        const cx = p[0] + dx * u, cy = p[1] + dy * u, d = Math.hypot(cx - o.x, cy - o.y);
        if (d >= o.r) continue;
        let nx = cx - o.x, ny = cy - o.y;
        if (Math.hypot(nx, ny) < 0.01) { nx = -dy; ny = dx; }
        const nl = Math.hypot(nx, ny);
        pts.splice(s + 1, 0, [o.x + nx / nl * (o.r + 1), o.y + ny / nl * (o.r + 1)]);
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  for (let k = 0; k < 3; k++) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) { const p = pts[i], q = pts[i + 1]; out.push([p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25], [p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75]); }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1], n = Math.max(20, Math.round(total / 1.2)), res = [];
  let j = 0;
  for (let s = 0; s <= n; s++) {
    const d = total * s / n;
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const u = (d - cum[j]) / ((cum[j + 1] - cum[j]) || 1);
    res.push([pts[j][0] + (pts[j + 1][0] - pts[j][0]) * u, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * u]);
  }
  return res;
}
function pathLen(p) { let L = 0; for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return L || 1; }
const fenceR = (t) => FENCE[Math.max(2, t.L) - 1];

/* ---------- view: projection, ground canvas with a margin ---------- */
const hero = document.getElementById('hero'), cv = document.getElementById('cv'), fx = document.getElementById('fx');
let W = 0, H = 0, dpr = 1, M = 200;
let K = 10, ox = 0, oy = 0;          // the live view (what the moving layer and taps use)
let bK = 10, bOx = 0, bOy = 0;       // the view the ground canvas was last drawn with
let roads = [], townT = new Map(), fitted = false;
const P = (x, y, z = 0) => [ox + (x - y) * K, oy + (x + y) * K * 0.5 - z * K];
const unP = (sx, sy) => { const a = (sx - ox) / K, b = 2 * (sy - oy) / K; return [(a + b) / 2, (b - a) / 2]; };
// The open part of the map: between the game buttons at the top and the game cards at the bottom.
const heroCards = document.getElementById('heroCards'), heroTop = document.querySelector('.hero .center');
let mapTop = 220, mapBottom = 560;
function measureArea() {
  const hr = hero.getBoundingClientRect();
  const cardsH = heroCards ? heroCards.getBoundingClientRect().height : 0;
  hero.style.setProperty('--cards-h', Math.round(cardsH) + 'px');
  mapTop = heroTop ? heroTop.getBoundingClientRect().bottom - hr.top + 10 : H * 0.3;
  mapBottom = hr.height - cardsH - 24;
  if (mapBottom - mapTop < 160) { mapTop = H * 0.3; mapBottom = H * 0.9; }
}
const focusY = () => (mapTop + mapBottom) / 2;
const viewCenter = () => unP(W / 2, focusY());
function lookAt(x, y) { ox = W / 2 - (x - y) * K; oy = focusY() - (x + y) * K * 0.5; }

function sizeCanvases() {
  const r = hero.getBoundingClientRect();
  W = r.width; H = r.height;
  measureArea();
  M = Math.round(clamp(Math.min(W, H) * 0.45, 160, 360));
  dpr = Math.min(2, window.devicePixelRatio || 1);
  // keep the ground canvas within a sane memory budget on big/high-density screens
  while (dpr > 1 && (W + 2 * M) * (H + 2 * M) * dpr * dpr > 9e6) dpr -= 0.25;
  cv.width = Math.round((W + 2 * M) * dpr); cv.height = Math.round((H + 2 * M) * dpr);
  Object.assign(cv.style, { left: -M + 'px', top: -M + 'px', width: W + 2 * M + 'px', height: H + 2 * M + 'px', transformOrigin: '0 0' });
  const fd = Math.min(2, window.devicePixelRatio || 1);
  fx.width = Math.round(W * fd); fx.height = Math.round(H * fd); fx._dpr = fd;
}

// first view: frame the nearby villages; on phones keep the player's own village (or the plot) centred
function fit() {
  const homeXY = MINE ? MINE : PLOT || HOME || { x: 0, y: 0 };
  const pts = TOWNS.filter((t) => Math.hypot(t.x - homeXY.x, t.y - homeXY.y) < D * 2.2).concat(PLOT ? [PLOT] : []);
  if (!pts.length) pts.push(homeXY);
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  pts.forEach((t) => { const sx = t.x - t.y, sy = (t.x + t.y) / 2; x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy); });
  K = clamp(Math.min(13, (W * 0.94) / (x1 - x0 + 30), ((mapBottom - mapTop) * 0.75) / (y1 - y0 + 14)), W < 700 ? 6.5 : 7, K_MAX);
  let cx = (x0 + x1) / 2;
  if ((x1 - x0 + 30) * K > W) cx = homeXY.x - homeXY.y;
  const cy = (y0 + y1) / 2;
  // centre (cx, cy) in iso space -> ground point
  lookAt(cy + cx / 2, cy - cx / 2);
  fitted = true;
}

// keep the view over the inhabited part of the world
function clampView() {
  const [cx, cy] = viewCenter();
  const lim = (EXTENT + 1.6) * D, d = Math.hypot(cx, cy);
  if (d > lim) lookAt(cx * lim / d, cy * lim / d);
}

// while moving: slide/scale the ground canvas instead of drawing it again
function placeGround() {
  const s = K / bK;
  const tx = ox - s * (M + bOx) + M, ty = oy - s * (M + bOy) + M;
  cv.style.transform = s === 1 && tx === 0 && ty === 0 ? '' : `translate(${tx}px,${ty}px) scale(${s})`;
}

function render() {
  if (!W) return;
  bK = K; bOx = ox; bOy = oy;
  cv.style.transform = '';
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const BW = W + 2 * M, BH = H + 2 * M;
  // ground canvas coordinates = screen + M
  const Pb = (x, y, z = 0) => { const p = P(x, y, z); return [p[0] + M, p[1] + M]; };
  const inside = (x, y, pad) => { const p = Pb(x, y); return p[0] > -pad && p[0] < BW + pad && p[1] > -pad && p[1] < BH + pad; };
  const g = c.createRadialGradient(BW / 2, BH * 0.6, 60, BW / 2, BH * 0.6, Math.max(BW, BH) * 0.75);
  g.addColorStop(0, '#92b76c'); g.addColorStop(1, '#68904b');
  c.fillStyle = g; c.fillRect(0, 0, BW, BH);
  // scatter is seeded by the ground position, so trees stay put when the map moves
  const scatterCell = 9;
  const [wx0, wy0] = unP(-M - 60, -M - 60), [wx1, wy1] = unP(W + M + 60, H + M + 60), [wx2, wy2] = unP(W + M + 60, -M - 60), [wx3, wy3] = unP(-M - 60, H + M + 60);
  const gx0 = Math.floor(Math.min(wx0, wx1, wx2, wx3) / scatterCell), gx1 = Math.ceil(Math.max(wx0, wx1, wx2, wx3) / scatterCell);
  const gy0 = Math.floor(Math.min(wy0, wy1, wy2, wy3) / scatterCell), gy1 = Math.ceil(Math.max(wy0, wy1, wy2, wy3) / scatterCell);
  const cells = [];
  for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) cells.push([gx, gy]);

  const near = (x, y) =>
    TOWNS.some((t) => Math.abs(t.x - x) < 14 && Math.abs(t.y - y) < 14 && Math.hypot(t.x - x, t.y - y) < Math.max(4, fenceR(t)) + 3) ||
    (PLOT && Math.hypot(PLOT.x - x, PLOT.y - y) < 7.5) ||
    roads.some((rd) => rd.q && rd.bb[0] - 2 < x && x < rd.bb[2] + 2 && rd.bb[1] - 2 < y && y < rd.bb[3] + 2 && rd.pts.some((q) => Math.abs(q[0] - x) < 1.8 && Math.abs(q[1] - y) < 1.8));

  // grass patches
  cells.forEach(([gx, gy]) => {
    const R = rng(((gx * 73856093) ^ (gy * 19349663)) >>> 0 || 1);
    for (let i = 0; i < 2; i++) { const x = (gx + R()) * scatterCell, y = (gy + R()) * scatterCell; if (inside(x, y, 40)) poly(c, blob(Pb, x, y, 0.8 + R() * 1.8, R() * 9, 12), R() < 0.5 ? 'rgba(120,160,80,.25)' : 'rgba(170,190,110,.2)'); }
  });

  // roads between villages near the drawn area
  const vis = new Set(TOWNS.map((t, i) => (inside(t.x, t.y, 900) ? i : -1)).filter((i) => i >= 0));
  roads = PAIRS.filter((p) => vis.has(p.a) || vis.has(p.b)).map((p) => {
    const pts = planRoute(TOWNS[p.a], TOWNS[p.b], [p.a, p.b]);
    let bb = [1e9, 1e9, -1e9, -1e9];
    pts.forEach(([x, y]) => { bb = [Math.min(bb[0], x), Math.min(bb[1], y), Math.max(bb[2], x), Math.max(bb[3], y)]; });
    return { pts, bb, q: quality(p.n), p };
  });
  if (roads.length) {
    let bb = [1e9, 1e9, -1e9, -1e9];
    roads.forEach((rd) => { bb = [Math.min(bb[0], rd.bb[0]), Math.min(bb[1], rd.bb[1]), Math.max(bb[2], rd.bb[2]), Math.max(bb[3], rd.bb[3])]; });
    naturalRoads(c, Pb, K, roads, [bb[0] - 10, bb[1] - 10, bb[2] + 10, bb[3] + 10], 0.3);
  }
  if (PLOT) {
    poly(c, blob(Pb, PLOT.x, PLOT.y, 6.5, 3, 32), 'rgba(170,196,118,.35)');
    poly(c, blob(Pb, PLOT.x, PLOT.y, 3.4, 3, 28), 'rgba(196,190,128,.4)');
  }

  // trees (seeded per ground cell) + villages, back to front
  const ents = [];
  cells.forEach(([gx, gy]) => {
    const R = rng((((gx + 7919) * 2654435761) ^ ((gy + 104729) * 40503)) >>> 0 || 1);
    for (let i = 0; i < 4; i++) {
      const x = (gx + R()) * scatterCell, y = (gy + R()) * scatterCell, k = R() < 0.4 ? 'pine' : R() < 0.12 ? 'bush' : 'tree', s = 0.8 + R() * 0.6;
      if (R() < 0.45 || !inside(x, y, 30) || near(x, y)) continue;
      ents.push({ t: 'tree', d: x + y, o: { x, y, k, s } });
    }
  });
  TOWNS.forEach((t, i) => { if (inside(t.x, t.y, 250)) ents.push({ t: 'town', d: t.x + t.y, o: t, i }); });
  ents.sort((a, b) => a.d - b.d);
  townT = new Map();
  ents.forEach((e) => {
    if (e.t === 'tree') { tree(c, Pb, e.o.x, e.o.y, e.o.s, K, e.o.k); return; }
    const t = e.o;
    try {
      const T = buildTown(t.L, t.seed, t.g);
      drawTown(c, (x, y, z = 0) => Pb(x + t.x, y + t.y, z), K, T, { cell: 0.18 });
      // chimney positions in ground-canvas pixels -> keep as ground offsets so smoke follows the map
      townT.set(t.name, { T, at: { K, ox, oy } });
    } catch (err) { console.error('village', t.name, err); }
  });
}

/* ---------- data from the server ---------- */
let matches = [], aiGames = [], smoke = [], floats = [];
let lastEvent = 0, firstLoad = true;
// games needed for each village level (the server sends them; this copy is only the fallback)
let LEVELS = [0, 1, 5, 12, 25, 45, 75, 120, 180, 260];
/** Where a village stands between its level and the next: games done / needed, and the share for the ring. */
function levelProgress(t) {
  const L = Math.max(1, t.L || 1), n = t.n || 0;
  const lo = LEVELS[L - 1] || 0, hi = LEVELS[L];
  if (hi === undefined) return { L, n, max: true, frac: 1 };
  return { L, n, max: false, done: Math.max(0, n - lo), need: hi - lo, frac: Math.max(0, Math.min(1, (n - lo) / (hi - lo))) };
}
const idx = (name) => TOWNS.findIndex((t) => t.name === name);
const pkey = (a, b) => (a < b ? a + '\u0001' + b : b + '\u0001' + a);

function eventHtml(e) {
  const n = (e.names || []).map((x) => '<b>' + esc(x) + '</b>');
  const both = n.length > 2 ? n.slice(0, -1).join(', ') + ' un ' + n[n.length - 1] : n.join(' un ');
  const game = e.game === 'm' ? 'Meļus' : 'Duraku';
  switch (e.type) {
    case 'start': return both + ' sāka spēlēt ' + game;
    case 'startSolo': return n[0] + (e.vsBot ? ' spēlē ' + game + ' pret datoru' : ' sāka spēlēt ' + game);
    case 'finish': return both + ' nospēlēja ' + game;
    case 'finishSolo': return n[0] + ' nospēlēja ' + game + (e.vsBot ? ' pret datoru' : '');
    case 'road': return 'Ceļš starp ' + n[0] + ' un ' + n[1] + ' kļuva par «' + (ROAD_NAMES[e.quality] || '') + '»';
    case 'level': return n[0] + ' ciemats izauga līdz <b>' + e.level + '.</b> līmenim';
    default: return null;
  }
}
// Village news: bubbles on the left of the map, kept by the server (the newest of any age).
// Computer: the 5 newest are always there, older ones fainter. Phone: hidden until "Parādīt notikumus"
// (the choice is remembered on that phone); while open, the map's +/− and home buttons step aside.
const FEED_SHOWN = 5;
let historySig = '';
let feedSeen = 0; // newest event id already on screen: only newer bubbles slide in
let feedOpen = false;
try { feedOpen = localStorage.getItem('uzs_feed_open') === '1'; } catch (e) { feedOpen = false; }
let lastHistory = [];
function ago(t) {
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return 'tikko';
  if (m < 60) return 'pirms ' + m + ' min';
  const h = Math.floor(m / 60);
  if (h < 24) return 'pirms ' + h + ' h';
  const d = Math.floor(h / 24);
  return d === 1 ? 'vakar' : 'pirms ' + d + ' dienām';
}
function renderHistory(list) {
  lastHistory = list;
  const f = document.getElementById('feed');
  if (!f) return;
  const items = list.map((e) => ({ e, h: eventHtml(e) })).filter((x) => x.h).slice(-FEED_SHOWN); // oldest first: the newest sits at the bottom
  const sig = JSON.stringify(items.map((x) => [x.e.id, ago(x.e.t)])) + feedOpen;
  if (sig === historySig) return;
  historySig = sig;
  const firstFill = feedSeen === 0;
  f.classList.toggle('open', feedOpen);
  document.body.classList.toggle('feed-open', feedOpen);
  f.innerHTML = '<button type="button" class="evtoggle" id="evToggle" aria-expanded="' + feedOpen + '">' + (feedOpen ? 'Paslēpt notikumus ▾' : 'Parādīt notikumus ▴') + '</button>' +
    '<div class="evlist">' + items.map((x, i) =>
      '<div class="ev age' + (items.length - 1 - i) + (!firstFill && x.e.id > feedSeen ? ' new' : '') + '"><span class="evt">' + x.h + '</span>' +
      '<time datetime="' + new Date(x.e.t).toISOString() + '">' + ago(x.e.t) + '</time></div>').join('') + '</div>';
  if (items.length) feedSeen = Math.max(feedSeen, items[items.length - 1].e.id);
  f.hidden = !items.length;
  document.getElementById('evToggle').onclick = () => {
    feedOpen = !feedOpen;
    try { localStorage.setItem('uzs_feed_open', feedOpen ? '1' : '0'); } catch (e) { /* not kept */ }
    historySig = '';
    renderHistory(lastHistory);
  };
}

function apply(data) {
  const s = site();
  VIEW = s.me ? 'in' : s.known ? 'known' : 'guest';
  EXTENT = data.extent || EXTENT;
  HOME = hexXY(data.home || data.center || { q: 0, r: 0 });
  reqCenter = data.center || reqCenter;

  // merge what came in with what was seen before; anything inside the window that is missing
  // now is gone (deleted account); things outside the window keep their last state, minus "online"
  const seen = new Set();
  (data.towns || []).forEach((t) => {
    seen.add(t.name);
    const old = townsBy.get(t.name);
    const nt = { ...t, ...hexXY(t), seed: nameHash(t.name) };
    townsBy.set(t.name, old ? Object.assign(old, nt) : nt);
  });
  for (const [name, t] of townsBy) {
    if (seen.has(name)) continue;
    if (hexDist(t, data.center) <= 3) townsBy.delete(name);
    else { t.online = false; }
  }
  (data.pairs || []).forEach((p) => pairsBy.set(pkey(p.a, p.b), p.n));
  TOWNS = [...townsBy.values()];
  if (Array.isArray(data.levels) && data.levels.length) LEVELS = data.levels;
  if (data.history) renderHistory(data.history);
  MINE = data.me ? townsBy.get(data.me) || null : null;
  TOWNS.forEach((t) => { t.mine = !!MINE && t === MINE; });
  PLOT = VIEW === 'guest' && data.plot ? hexXY(data.plot) : null;
  PAIRS = [];
  for (const [k, n] of pairsBy) { const [a, b] = k.split('\u0001'); const ia = idx(a), ib = idx(b); if (ia >= 0 && ib >= 0) PAIRS.push({ a: ia, b: ib, n }); }

  if (!fitted) { fit(); clampView(); }
  const sig = JSON.stringify([TOWNS.map((t) => [t.name, t.L, t.g, t.x, t.y]), PAIRS.map((p) => [p.a, p.b, quality(p.n)]), PLOT]);
  if (sig !== baseSig && !gesture) { baseSig = sig; render(); }
  else if (sig !== baseSig) needRender = true;

  // walkers: keep the ones still playing where they are, add new ones
  const was = new Map(matches.map((m) => [m.id, m]));
  matches = (data.matches || []).map((m) => {
    const a = idx(m.a), b = idx(m.b);
    if (a < 0 || b < 0) return null;
    const old = was.get(m.id);
    if (old && old.an === m.a && old.bn === m.b) return Object.assign(old, { a, b });
    const A = TOWNS[a], B = TOWNS[b];
    const road = roads.find((r) => (r.p.a === a && r.p.b === b) || (r.p.a === b && r.p.b === a));
    const pts = road ? road.pts : planRoute(A, B, [a, b]);
    const len = pathLen(pts), lo = (fenceR(A) + 0.6) / len, hi = 1 - (fenceR(B) + 0.6) / len;
    if (hi <= lo) return null;
    return { id: m.id, a, b, an: m.a, bn: m.b, g: m.g, pts, lo, hi, t: lo + Math.random() * (hi - lo), dir: 1 };
  }).filter(Boolean);
  const wasAi = new Map(aiGames.map((g) => [g.id, g]));
  aiGames = (data.solo || []).map((g) => {
    const i = idx(g.name);
    if (i < 0) return null;
    return Object.assign(wasAi.get(g.id) || { id: g.id, g: g.g, t: Math.random() * 6.28 }, { i });
  }).filter(Boolean);

  // finished games between two villages on screen get a "+1" over their road (the news itself: renderHistory)
  const fresh = (data.events || []).filter((e) => e.id > lastEvent);
  // on opening the page only the last few minutes are news; older lines would read as "happening now"
  const recent = (e) => !e.t || Date.now() - e.t < 3 * 60 * 1000;
  (firstLoad ? fresh.filter(recent).slice(-3) : fresh).forEach((e) => {
    if (!firstLoad && e.type === 'finish') {
      const a = idx(e.names[0]), b = idx(e.names[1]);
      const road = roads.find((r) => (r.p.a === a && r.p.b === b) || (r.p.a === b && r.p.b === a));
      if (road) { const mid = road.pts[Math.floor(road.pts.length / 2)]; floats.push({ x: mid[0], y: mid[1], t: 0 }); }
    }
  });
  if (data.events && data.events.length) lastEvent = Math.max(lastEvent, data.events[data.events.length - 1].id);
  firstLoad = false;

  const c = data.counts || { playing: 0, online: 0, tables: { d: 0, m: 0 } };
  document.getElementById('liveN').textContent = c.playing;
  document.getElementById('onlineN').textContent = Math.max(c.online, c.playing);
  document.getElementById('dStat').textContent = 'Tagad notiek: ' + plural(c.tables.d || 0, 'spēle', 'spēles');
  document.getElementById('mStat').textContent = 'Tagad notiek: ' + plural(c.tables.m || 0, 'spēle', 'spēles');
  updHomeBtn();
}

let loading = false, again = null;
// Every check-in also tells the server "this tab still has the front page open", so a visitor shows
// online without opening a game (the page keeps no permanent connection). The id is per browser tab
// (kept over a reload); a logged-in visitor adds the saved login, which the server checks read-only.
const store = (area, k, v) => { try { if (v === undefined) return window[area].getItem(k); window[area].setItem(k, v); } catch (e) { /* blocked */ } return null; };
const VISIT_ID = (() => {
  let id = store('sessionStorage', 'uzs_visit');
  if (!/^[A-Za-z0-9]{8,40}$/.test(id || '')) {
    const a = new Uint8Array(12);
    (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => { a[i] = Math.random() * 256; });
    id = Array.from(a, (b) => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 56]).join('');
    store('sessionStorage', 'uzs_visit', id);
  }
  return id;
})();
function visitHeaders() {
  const h = { 'X-Uzs-Visit': VISIT_ID };
  const u = store('localStorage', 'duraks_username');
  const tk = store('localStorage', 'duraks_token');
  if (u && tk) { h['X-Uzs-User'] = encodeURIComponent(u); h['X-Uzs-Token'] = tk; }
  if (document.hidden) h['X-Uzs-Hidden'] = '1';
  return h;
}
function load(at) {
  if (loading) { again = at || reqCenter || true; return; }
  loading = true;
  const who = site().known;
  const qs = [];
  if (who) qs.push('me=' + encodeURIComponent(who));
  if (at && at !== true) qs.push('q=' + at.q, 'r=' + at.r);
  fetch(API + (qs.length ? '?' + qs.join('&') : ''), { cache: 'no-store', headers: visitHeaders() })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { if (d) apply(d); })
    .catch(() => { /* offline for a moment: keep the last picture */ })
    .then(() => { loading = false; if (again) { const a = again; again = null; load(a); } });
}
// after the map has moved: ask for the area now in view, if it is a new one
function loadView() {
  const [x, y] = viewCenter();
  const h = xyHex(x, y);
  if (!reqCenter || hexDist(h, reqCenter) >= 1) load(h);
}

/* ---------- frame ---------- */
function frame(ts) {
  const c = fx.getContext('2d'), fd = fx._dpr || 1;
  c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, fx.width, fx.height); c.setTransform(fd, 0, 0, fd, 0, 0);
  if (!W || !fitted) { nextFrame(); return; }
  // smoke from villages whose owner is online (chimneys were found when the village was drawn)
  TOWNS.forEach((t) => {
    const e = townT.get(t.name);
    if (!e || !t.online || !e.T.chimneys.length) return;
    if (!reduce && Math.random() < 0.12) {
      const ch = e.T.chimneys[Math.random() * e.T.chimneys.length | 0];
      // chimney pixel (ground canvas) -> ground-relative offset, so it follows drags and zoom
      const k = K / e.at.K;
      smoke.push({ name: t.name, dx: (ch[0] - M - e.at.ox) / e.at.K, dy: (ch[1] - M - e.at.oy) / e.at.K, up: 0, r: 1.5, a: 0.55, k });
    }
  });
  smoke.forEach((s) => { s.up += 0.35; s.dx += 0.015; s.r += 0.05; s.a -= 0.005; });
  smoke = smoke.filter((s) => s.a > 0);
  smoke.forEach((s) => { const x = ox + s.dx * K, y = oy + s.dy * K - s.up; c.fillStyle = `rgba(236,240,242,${s.a})`; c.beginPath(); c.arc(x, y, s.r * K / 10, 0, 7); c.fill(); });
  // level progress: a gold ring on the ground round each village (how far to the next level) and the
  // level on a small coin at its front; ★ at the top level
  TOWNS.forEach((t) => {
    const pr = levelProgress(t);
    const R = Math.max(3.2, fenceR(t)) + 0.9;
    const arc = (f1, col, w) => {
      const steps = Math.max(2, Math.ceil(64 * f1));
      c.strokeStyle = col; c.lineWidth = w; c.lineCap = 'round'; c.beginPath();
      for (let i = 0; i <= steps; i++) {
        const a = -Math.PI / 2 + (i / steps) * f1 * Math.PI * 2;
        const p = P(t.x + Math.cos(a) * R, t.y + Math.sin(a) * R);
        if (i) c.lineTo(p[0], p[1]); else c.moveTo(p[0], p[1]);
      }
      c.stroke(); c.lineCap = 'butt';
    };
    arc(1, 'rgba(14,40,54,.35)', 4);
    if (pr.frac > 0) arc(pr.frac, '#e2c374', 4);
    const p = P(t.x + R * 0.71, t.y + R * 0.71);
    c.fillStyle = '#16303d'; c.strokeStyle = '#e2c374'; c.lineWidth = 1.6;
    c.beginPath(); c.arc(p[0], p[1], 10, 0, 7); c.fill(); c.stroke();
    c.fillStyle = '#e2c374'; c.font = '800 12px Georgia'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(pr.max ? '★' : String(pr.L), p[0], p[1] + 0.5);
  });
  // tournament bunting
  TOWNS.forEach((t) => {
    if (!t.tour) return;
    // small villages have no fence yet: keep the flags around the hut, not on top of it
    const r = Math.max(4, FENCE[Math.max(1, t.L) - 1] || 0);
    const cols = ['#c9a24b', '#b3261e', '#2f7391', '#faf6ec'];
    for (let s = 0; s < 4; s++) {
      const a0 = s * 1.57 + 0.3, pts = [];
      for (let i = 0; i <= 8; i++) { const a = a0 + i * 0.12; pts.push(P(t.x + Math.cos(a) * r * 0.75, t.y + Math.sin(a) * r * 0.75, 1.6 + Math.sin(i / 8 * Math.PI) * -0.4)); }
      c.strokeStyle = 'rgba(60,40,20,.6)'; c.lineWidth = 0.8; c.beginPath(); pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]))); c.stroke();
      pts.forEach((p, i) => { if (i === pts.length - 1) return; const sw = reduce ? 0 : Math.sin(ts / 300 + i) * 1.2; c.fillStyle = cols[i % 4]; c.beginPath(); c.moveTo(p[0], p[1]); c.lineTo(p[0] + 4, p[1]); c.lineTo(p[0] + 2 + sw, p[1] + 6); c.fill(); });
    }
  });
  // walkers for games between two villages on screen
  matches.forEach((m) => {
    if (!reduce) { m.t += 0.04 / pathLen(m.pts) * m.dir; if (m.t > m.hi || m.t < m.lo) { m.dir *= -1; m.t = clamp(m.t, m.lo, m.hi); } }
    [0, 1].forEach((s) => {
      const tt = s ? (m.lo + m.hi) - m.t : m.t;
      const p = P(...along(m.pts, tt));
      person(c, p, s ? '#a8323e' : '#2f7391', K * 1.5);
      if (s === 0) {
        c.fillStyle = 'rgba(250,246,236,.95)'; c.strokeStyle = m.g === 'd' ? '#2f7391' : '#a8323e'; c.lineWidth = 1.2;
        c.beginPath(); c.roundRect(p[0] - 8, p[1] - K * 1.5 * 0.75 - 20, 16, 14, 4); c.fill(); c.stroke();
        c.fillStyle = m.g === 'd' ? '#1d232a' : '#b3261e'; c.font = 'bold 11px Georgia'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(m.g === 'd' ? '♠' : '♥', p[0], p[1] - K * 1.5 * 0.75 - 13);
      }
    });
  });
  // a game against the computer or someone off screen: a figure walks round the village hall
  aiGames.forEach((g) => {
    const t = TOWNS[g.i];
    if (!t) return;
    if (!reduce) g.t += 0.01;
    const r = Math.max(1.6, FENCE[Math.max(3, t.L) - 1] * 0.35);
    person(c, P(t.x + Math.cos(g.t) * r, t.y + Math.sin(g.t) * r), g.g === 'm' ? '#a8323e' : '#c9a24b', K * 1.5);
  });
  // +1 over a road when a game finishes
  floats.forEach((f) => {
    f.t += reduce ? 0.02 : 0.008;
    const p = P(f.x, f.y);
    c.globalAlpha = Math.max(0, 1 - f.t); c.fillStyle = '#e2c374'; c.strokeStyle = 'rgba(14,40,54,.8)'; c.lineWidth = 3;
    c.font = '800 16px -apple-system,Segoe UI,sans-serif'; c.textAlign = 'center';
    c.strokeText('+1', p[0], p[1] - f.t * 40); c.fillText('+1', p[0], p[1] - f.t * 40); c.globalAlpha = 1;
  });
  floats = floats.filter((f) => f.t < 1);
  // the free plot: only for visitors who have never logged in on this browser
  if (PLOT) {
    c.setLineDash([2, 7]); poly(c, blob(P, PLOT.x, PLOT.y, R_MAX, 0, 48), null, 'rgba(255,236,160,.45)', 1.5); c.setLineDash([]);
    if (!reduce) for (let w = 0; w < 3; w++) { const f = ((ts / 2600) + w / 3) % 1; poly(c, blob(P, PLOT.x, PLOT.y, 3 + f * (R_MAX - 3), 0, 40), null, `rgba(255,226,140,${0.55 * (1 - f)})`, 2); }
    const ph = reduce ? 0.5 : (Math.sin(ts / 520) + 1) / 2;
    const g = P(PLOT.x, PLOT.y), rx = (3.1 + ph * 0.7) * K;
    c.save(); c.translate(g[0], g[1]); c.scale(1, 0.5);
    const gr = c.createRadialGradient(0, 0, rx * 0.2, 0, 0, rx * 1.15);
    gr.addColorStop(0, `rgba(255,214,110,${0.5 + ph * 0.35})`); gr.addColorStop(1, 'rgba(255,214,110,0)');
    c.fillStyle = gr; c.beginPath(); c.arc(0, 0, rx * 1.15, 0, 7); c.fill();
    c.restore();
    c.setLineDash([7, 5]); c.lineDashOffset = reduce ? 0 : -ts / 60; poly(c, blob(P, PLOT.x, PLOT.y, 3 + ph * 0.3, 3, 32), null, `rgba(255,236,160,${0.75 + ph * 0.25})`, 2.5); c.setLineDash([]);
    {
      const s = P(PLOT.x, PLOT.y), top = P(PLOT.x, PLOT.y, 2.6);
      c.strokeStyle = '#6b4a2a'; c.lineWidth = 3; c.beginPath(); c.moveTo(s[0], s[1]); c.lineTo(top[0], top[1]); c.stroke();
      const wv = reduce ? 0 : Math.sin(ts / 260) * 3;
      c.fillStyle = '#e2c374'; c.strokeStyle = '#8a6a22'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(top[0], top[1]); c.quadraticCurveTo(top[0] + 12, top[1] + 3 + wv, top[0] + 24, top[1] + 6); c.lineTo(top[0], top[1] + 14); c.closePath(); c.fill(); c.stroke();
      c.fillStyle = '#2a2005'; c.font = 'bold 10px Georgia'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('+', top[0] + 8, top[1] + 7);
    }
    for (let i = 0; i < 5; i++) { const a = i * 1.26 + ts / 1400, s = P(PLOT.x + Math.cos(a) * 2.1, PLOT.y + Math.sin(a) * 2.1, 0.6 + 0.4 * Math.sin(ts / 400 + i)); c.fillStyle = `rgba(255,240,190,${0.5 + 0.5 * Math.sin(ts / 300 + i)})`; c.beginPath(); c.arc(s[0], s[1], 2.2, 0, 7); c.fill(); }
  }
  // my own village: a gold ring once we know who this is
  if (VIEW !== 'guest' && MINE) {
    const t = MINE, r = Math.max(3.2, fenceR(t)) + 1.8; // outside the level ring; a hut has no fence: keep the label clear of it
    c.setLineDash([3, 6]); poly(c, blob(P, t.x, t.y, r, 2, 40), null, 'rgba(226,195,116,.85)', 2); c.setLineDash([]);
    const p = P(t.x, t.y - r - 0.6);
    c.font = '700 12px -apple-system,Segoe UI,sans-serif'; c.textAlign = 'center';
    const lbl = VIEW === 'in' ? 'Tavs ciemats' : 'Tavs ciemats? Ielogojies';
    const tw = c.measureText(lbl).width + 14;
    c.fillStyle = 'rgba(226,195,116,.95)'; c.beginPath(); c.roundRect(p[0] - tw / 2, p[1] - 14, tw, 19, 9); c.fill();
    c.fillStyle = '#2a2005'; c.textBaseline = 'alphabetic'; c.fillText(lbl, p[0], p[1]);
  }
  if (sel && townsBy.get(sel)) { const t = townsBy.get(sel), r = Math.max(3.2, fenceR(t)) + 1.6; c.setLineDash([6, 5]); poly(c, blob(P, t.x, t.y, r, 1, 36), null, '#e2c374', 2); c.setLineDash([]); }
  nextFrame();
}
// The animation only runs while the map is on screen: scrolled away, it waits (nothing visible changes)
// and picks up again where it stopped once the map is back in view.
let heroInView = true, framePaused = false;
function nextFrame() {
  if (heroInView) requestAnimationFrame(frame); else framePaused = true;
}
if ('IntersectionObserver' in window) {
  new IntersectionObserver((entries) => {
    heroInView = entries[entries.length - 1].isIntersecting;
    if (heroInView && framePaused) { framePaused = false; requestAnimationFrame(frame); }
  }).observe(hero);
}

/* ---------- moving around ---------- */
const ctl = document.createElement('div');
ctl.className = 'mapctl';
ctl.innerHTML = '<button type="button" class="mbtn home" id="mapHome" hidden></button><div class="zoom"><button type="button" class="mbtn" id="zoomIn" aria-label="Pietuvināt">+</button><button type="button" class="mbtn" id="zoomOut" aria-label="Attālināt">−</button></div>';
hero.appendChild(ctl);
const tip = document.createElement('div');
tip.className = 'maptip'; tip.hidden = true; tip.setAttribute('role', 'status');
tip.textContent = 'Izmanto divus pirkstus, lai pārvietotu karti';
hero.appendChild(tip);
let tipTimer = null;
function showTip() { tip.hidden = false; clearTimeout(tipTimer); tipTimer = setTimeout(() => { tip.hidden = true; }, 1600); }

let gesture = null, needRender = false, movedAt = 0;
function closePops() { pop.hidden = true; plotPop.hidden = true; sel = null; }
function startMove() { closePops(); }
function moveBy(dx, dy) { ox += dx; oy += dy; clampView(); placeGround(); }
function zoomAt(f, sx, sy) {
  const nk = clamp(K * f, K_MIN, K_MAX), [wx, wy] = unP(sx, sy);
  K = nk;
  ox = sx - (wx - wy) * K; oy = sy - (wx + wy) * K * 0.5;
  clampView(); placeGround();
}
// one redraw when the movement ends (or mid-drag, if it has run past the drawn margin)
function settle() {
  const s = K / bK, tx = ox - bOx, ty = oy - bOy;
  if (s !== 1 || Math.abs(tx) > 1 || Math.abs(ty) > 1 || needRender) { needRender = false; render(); }
  loadView();
  updHomeBtn();
}
function pastMargin() { return Math.abs(ox - bOx) > M * 0.85 || Math.abs(oy - bOy) > M * 0.85; }

// mouse: grab and drag
fx.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'mouse' || e.button !== 0) return;
  gesture = { kind: 'mouse', x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
});
window.addEventListener('pointermove', (e) => {
  if (!gesture || gesture.kind !== 'mouse') return;
  const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
  if (!gesture.moved && Math.hypot(dx, dy) < 5) return;
  if (!gesture.moved) { gesture.moved = true; startMove(); fx.classList.add('grabbing'); try { fx.setPointerCapture(gesture.id); } catch (err) { /* fine */ } }
  gesture.x = e.clientX; gesture.y = e.clientY;
  moveBy(dx, dy);
  if (pastMargin()) render();
});
window.addEventListener('pointerup', () => {
  if (!gesture || gesture.kind !== 'mouse') return;
  const moved = gesture.moved;
  gesture = null; fx.classList.remove('grabbing');
  if (moved) { movedAt = performance.now(); settle(); }
});
// trackpad pinch (arrives as ctrl+wheel); a plain wheel keeps scrolling the page
fx.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  closePops();
  const r = fx.getBoundingClientRect();
  zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
  clearTimeout(fx._wt); fx._wt = setTimeout(settle, 180);
}, { passive: false });

// touch: two fingers move and pinch; one finger scrolls the page as usual
const mid = (t) => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];
const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
let oneFinger = null;
fx.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    e.preventDefault();
    const [mx, my] = mid(e.touches);
    gesture = { kind: 'touch', mx, my, d: spread(e.touches) };
    startMove();
  } else if (e.touches.length === 1) {
    oneFinger = { x: e.touches[0].clientX, y: e.touches[0].clientY, warned: false };
  }
}, { passive: false });
fx.addEventListener('touchmove', (e) => {
  if (gesture && gesture.kind === 'touch' && e.touches.length >= 2) {
    e.preventDefault();
    const [mx, my] = mid(e.touches), d = spread(e.touches), r = fx.getBoundingClientRect();
    moveBy(mx - gesture.mx, my - gesture.my);
    if (gesture.d > 20) zoomAt(d / gesture.d, mx - r.left, my - r.top);
    gesture.mx = mx; gesture.my = my; gesture.d = d;
    if (pastMargin()) render();
  } else if (oneFinger && e.touches.length === 1 && !oneFinger.warned) {
    const dx = e.touches[0].clientX - oneFinger.x, dy = e.touches[0].clientY - oneFinger.y;
    // a sideways swipe with one finger: tell how to move the map (an up/down swipe just scrolls)
    if (Math.abs(dx) > 24 && Math.abs(dx) > Math.abs(dy) * 1.5) { oneFinger.warned = true; showTip(); }
  }
}, { passive: false });
fx.addEventListener('touchend', (e) => {
  if (gesture && gesture.kind === 'touch' && e.touches.length < 2) { gesture = null; movedAt = performance.now(); settle(); }
  if (!e.touches.length) oneFinger = null;
});
fx.addEventListener('touchcancel', () => { if (gesture) { gesture = null; settle(); } oneFinger = null; });

// buttons: zoom, and back home with a short glide
function zoomBtn(f) { closePops(); zoomAt(f, W / 2, focusY()); clearTimeout(fx._zt); fx._zt = setTimeout(settle, 250); }
document.getElementById('zoomIn').addEventListener('click', () => zoomBtn(1.3));
document.getElementById('zoomOut').addEventListener('click', () => zoomBtn(1 / 1.3));
const homeTarget = () => MINE || PLOT || HOME;
function updHomeBtn() {
  const b = document.getElementById('mapHome'), h = homeTarget();
  if (!h || !W) { b.hidden = true; return; }
  const [cx, cy] = viewCenter();
  b.textContent = MINE ? '⌂ Uz manu ciematu' : PLOT ? '⌂ Uz brīvo zemi' : '⌂ Atpakaļ';
  b.hidden = Math.hypot(cx - h.x, cy - h.y) < D * 0.9;
}
document.getElementById('mapHome').addEventListener('click', () => {
  const h = homeTarget();
  if (!h) return;
  closePops();
  const [sx, sy] = viewCenter(), t0 = performance.now(), dur = reduce ? 0 : 450;
  const step = (now) => {
    const u = dur ? Math.min(1, (now - t0) / dur) : 1, e = 1 - Math.pow(1 - u, 3);
    lookAt(sx + (h.x - sx) * e, sy + (h.y - sy) * e);
    placeGround();
    if (u < 1) requestAnimationFrame(step); else settle();
  };
  requestAnimationFrame(step);
});

/* ---------- tap a village or the plot ---------- */
let sel = null; // selected village's name
const pop = document.getElementById('pop');
const plotPop = document.getElementById('plotPop');
function openAuth(m) { closePops(); if (window.UzsSite) window.UzsSite.openModal(m); }
// place a card above a point, or below it when there is no room above (the header lives there)
function placeCard(el, x, y) {
  el.classList.remove('below');
  el.style.left = clamp(x, 145, W - 145) + 'px';
  el.style.top = y + 'px';
  el.hidden = false;
  if (y - el.offsetHeight - 14 < 64) { el.classList.add('below'); el.style.top = (y + 18) + 'px'; }
}
const pct = (w, n) => (n ? Math.round(w / n * 100) + '%' : '—');
let cardReq = 0;
function villageCard(t) {
  const status = (s) => (s.online ? (s.playing ? 'tagad spēlē' : 'tiešsaistē') : 'nav tiešsaistē');
  // this page doesn't keep a connection open, so the server can't see you here: you are online
  const meHere = t.mine && VIEW === 'in';
  // games to the next level, in one line, with a bar like the ring on the map
  const progress = () => {
    const pr = levelProgress(t);
    const label = pr.max ? 'Maks. līmenis ★' : 'Līdz ' + (pr.L + 1) + '. līmenim';
    const count = pr.max ? plural(pr.n, 'spēle', 'spēles') : pr.done + '/' + pr.need + ' spēles';
    return '<div class="lvprog"><div class="lvtxt"><span>' + label + '</span><b>' + count + '</b></div>' +
      '<div class="lvbar" role="progressbar" aria-label="' + label + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(pr.frac * 100) + '"><i style="width:' + Math.round(pr.frac * 100) + '%"></i></div></div>';
  };
  const head = (L, s) => '<h3><span class="lv">' + L + '</span>' + esc(t.name) + '</h3><p>' + status(meHere ? { online: true, playing: s.playing } : s) + (t.tour ? ' · rīko turnīru' : '') + '</p>' + progress();
  const playingNow = matches.some((m) => m.an === t.name || m.bn === t.name) || aiGames.some((g) => TOWNS[g.i] === t);
  let foot = '';
  if (t.mine && VIEW === 'known') foot = '<div class="row"><button type="button" class="gold" id="popLogin">Ielogoties</button></div>';
  // the full profile window (ELO chart, latest games …) is for logged-in players; others get a way in
  else if (VIEW !== 'in') foot = '<div class="row more"><button type="button" id="popMoreLogin">🔒 Pilna statistika — ielogojies</button></div>';
  pop.innerHTML = head(t.L, { online: t.online, playing: playingNow }) + '<p class="loading">Ielādē statistiku…</p>' + foot;
  const p = P(t.x, t.y, 1);
  placeCard(pop, p[0], Math.max(150, p[1] - t.L * 3));
  wireLogin(t);
  const my = ++cardReq;
  fetch('/api/player?name=' + encodeURIComponent(t.name), { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((s) => {
      if (my !== cardReq || pop.hidden || sel !== t.name) return;
      if (!s) { pop.querySelector('.loading').textContent = 'Statistika nav pieejama.'; return; }
      const rows = [];
      rows.push(['Spēles kopā', String(s.games.d + s.games.m)]);
      rows.push(['Duraks', s.duraks.played ? s.duraks.won + ' / ' + s.duraks.played + ' uzvaras · ' + pct(s.duraks.won, s.duraks.played) : 'vēl nav spēlēts']);
      if (s.duraks.played) rows.push(['ELO', s.elo.oneVOne + ' (1:1) · ' + s.elo.multi + ' (3–4)']);
      rows.push(['Meļi', s.meli.played ? s.meli.won + ' / ' + s.meli.played + ' uzvaras · ' + pct(s.meli.won, s.meli.played) : 'vēl nav spēlēts']);
      const streak = Math.max(s.duraks.longestStreak || 0, s.meli.longestStreak || 0);
      if (streak > 1) rows.push(['Garākā sērija', plural(streak, 'uzvara', 'uzvaras') + ' pēc kārtas']);
      const me = site().me;
      if (me && me !== t.name) { const n = pairsBy.get(pkey(me, t.name)) || 0; rows.push(['Kopā ar tevi', plural(n, 'spēle', 'spēles')]); }
      if (s.since) rows.push(['Ciematā kopš', new Date(s.since).toLocaleDateString('lv-LV', { year: 'numeric', month: 'long' })]);
      pop.innerHTML = head(s.level, s) + '<dl class="pstats">' + rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + esc(v) + '</dd>').join('') + '</dl>' + foot;
      placeCard(pop, p[0], Math.max(150, p[1] - t.L * 3));
      wireLogin(t);
    });
}
function wireLogin(t) {
  const ml = document.getElementById('popMoreLogin');
  if (ml) ml.onclick = () => openAuth(site().known ? 'login' : 'signup');
  const pl = document.getElementById('popLogin');
  if (pl) pl.onclick = () => { openAuth('login'); const u = document.getElementById('fUser'); if (u) u.value = t.name; };
}
fx.addEventListener('click', (e) => {
  if (!W || performance.now() - movedAt < 250) return; // that was the end of a drag, not a tap
  const r = fx.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  plotPop.hidden = true;
  if (PLOT) {
    const g = P(PLOT.x, PLOT.y);
    if (Math.hypot(mx - g[0], (my - g[1]) * 2) < Math.max(3.6 * K, 26)) {
      pop.hidden = true; sel = null;
      plotPop.innerHTML = '<h3>Brīvs zemes gabals</h3><p>Reģistrējies, un šeit uzcelsim tavu pirmo būdiņu. Ar katru spēli tā augs.</p><div class="row"><button type="button" class="gold" id="ppReg">Reģistrēties</button><button type="button" id="ppHave">Man jau ir konts</button></div>';
      placeCard(plotPop, g[0], g[1] - 12);
      document.getElementById('ppReg').onclick = () => openAuth('signup');
      document.getElementById('ppHave').onclick = () => openAuth('login');
      return;
    }
  }
  let best = null, bd = 1e9;
  TOWNS.forEach((t) => { const p = P(t.x, t.y); const d = Math.hypot(p[0] - mx, p[1] - my); if (d < bd) { bd = d; best = t; } });
  if (!best || bd > Math.max((Math.max(3, fenceR(best)) + 1) * K, 22)) { closePops(); return; }
  if (VIEW === 'in' && window.UzsProfile && window.UzsProfile.open(best.name)) { closePops(); return; }
  sel = best.name;
  villageCard(best);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePops(); });

/* ---------- start ---------- */
let rt = null;
function onResize() {
  const keep = W ? viewCenter() : null;
  sizeCanvases();
  if (keep && fitted) { lookAt(keep[0], keep[1]); render(); }
  closePops(); updHomeBtn();
}
new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(onResize, 120); }).observe(hero);
sizeCanvases();
let lastWho = JSON.stringify(site());
if (window.UzsSite) window.UzsSite.onChange(() => { const who = JSON.stringify(site()); if (who === lastWho) return; lastWho = who; fitted = false; townsBy.clear(); pairsBy.clear(); baseSig = ''; reqCenter = null; load(); });
load();
// visible: every 10 s; a background tab only checks in every 50 s (enough to stay shown online)
let ticks = 0;
setInterval(() => {
  ticks += 1;
  if (gesture) return;
  if (!document.hidden || ticks % 5 === 0) load(reqCenter);
}, POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(reqCenter); });
requestAnimationFrame(frame);

})();
