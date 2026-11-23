import * as T from '/js/three.module.min.js';
const box=document.getElementById('office');
const R=new T.WebGLRenderer({antialias:true,alpha:false});R.setPixelRatio(Math.min(devicePixelRatio,2));R.shadowMap.enabled=true;R.shadowMap.type=T.PCFSoftShadowMap;R.outputColorSpace=T.SRGBColorSpace;R.toneMapping=T.ACESFilmicToneMapping;R.toneMappingExposure=1.05;
box.appendChild(R.domElement);
const S=new T.Scene();S.background=new T.Color('#f7efe2');S.fog=new T.Fog('#f7efe2',22,40);
const C=new T.PerspectiveCamera(42,1,.1,100);
const M=(c,o={})=>new T.MeshStandardMaterial({color:c,roughness:.75,metalness:0,...o});
const mesh=(g,m,p=[0,0,0],sh=true)=>{const x=new T.Mesh(g,m);x.position.set(...p);x.castShadow=sh;x.receiveShadow=true;return x};
const rbox=(w,h,d)=>new T.BoxGeometry(w,h,d);
// lights
S.add(new T.HemisphereLight('#fffaf2','#e2c9a4',.95));
const sun=new T.DirectionalLight('#fff1d6',1.9);sun.position.set(-5,11,-2);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-9,right:9,top:8,bottom:-8});sun.shadow.bias=-.0004;sun.shadow.normalBias=.02;sun.shadow.radius=6;S.add(sun);
const fill=new T.DirectionalLight('#ffe9d2',.55);fill.position.set(4,6,12);S.add(fill);
S.add(new T.AmbientLight('#fff6ea',.25));
// room
const floor=mesh(new T.PlaneGeometry(22,14),M('#d8b48a',{roughness:.6}),[0,0,0],false);floor.rotation.x=-Math.PI/2;S.add(floor);
for(let i=-10;i<=10;i+=1.1){const l=mesh(rbox(.02,.002,14),M('#c79f74'),[i,.001,0],false);S.add(l)}
const wallM=M('#fbf3e6',{roughness:.95,emissive:'#f6ead8',emissiveIntensity:.45});
const back=mesh(rbox(22,7,.2),wallM,[0,3.5,-5],false);S.add(back);
const side=mesh(rbox(.2,7,14),wallM,[-9,3.5,2],false);S.add(side);
S.add(mesh(rbox(22,.3,.25),M('#ead9bf'),[0,.15,-4.85],false));
// windows on back wall
for(const x of [-5,0,5]){const f=mesh(rbox(3,2.2,.08),M('#ffffff'),[x,4.3,-4.88],false);S.add(f);const g=mesh(rbox(2.7,1.9,.05),M('#dff0fb',{emissive:'#e8f6ff',emissiveIntensity:.6}),[x,4.3,-4.83],false);S.add(g);S.add(mesh(rbox(.06,1.9,.07),M('#fff'),[x,4.3,-4.8],false))}
// shelf + pendant lamps
S.add(mesh(rbox(3,.1,.5),M('#c9a37a'),[-7,2.6,-4.6]));
for(let i=0;i<4;i++)S.add(mesh(rbox(.3,.5+.1*(i%2),.35),M(['#f4a261','#90caf9','#a5d6a7','#f8bbd0'][i]),[-8+i*.5,2.9,-4.6]));
const plant=(x,z,s=1)=>{const g=new T.Group();g.add(mesh(new T.CylinderGeometry(.28*s,.22*s,.5*s,16),M('#f1e4d0'),[0,.25*s,0]));for(let i=0;i<7;i++){const l=mesh(new T.SphereGeometry(.28*s,12,10),M(i%2?'#7cb87a':'#5e9e63'),[Math.cos(i)*.2*s,.75*s+(i%3)*.18*s,Math.sin(i*2)*.2*s]);l.scale.set(1,1.4,1);g.add(l)}g.position.set(x,0,z);S.add(g);return g};
plant(-8,-4,1.4);plant(8,-4,1.2);plant(8.3,3.5,1);
// rug
const rug=mesh(new T.CircleGeometry(5.5,48),M('#efe0c8'),[0,.01,.8],false);rug.rotation.x=-Math.PI/2;rug.scale.set(1.25,.7,1);S.add(rug);
// characters
const SPEC={score:{fur:'#86bdf5',belly:'#eef6ff',ear:'cat',acc:'phones',scr:'#4f9cf5',x:-3.5,mons:2},risk:{fur:'#f2a65f',belly:'#fff4e6',ear:'shiba',acc:'scarf',scr:'#f59e42',x:0,mons:3},copy:{fur:'#94d68e',belly:'#f1fbec',ear:'bunny',acc:'none',scr:'#3fbf5a',x:3.5,mons:2}};
const st={};
function scrTex(col,kind){const c=document.createElement('canvas');c.width=256;c.height=512;const x=c.getContext('2d');x.fillStyle='#141a26';x.fillRect(0,0,256,512);
 for(let y=0;y<512;y+=32){const r=Math.random();if(kind==1){x.fillStyle=r>.5?'#3fd47a':'#ff6b6b';x.fillRect(20,y+8,40+r*150,14)}else{x.fillStyle=col;x.globalAlpha=.9;x.fillRect(16,y+8,30+r*170,10);x.globalAlpha=.5;x.fillStyle='#fff';x.fillRect(16,y+22,20+r*90,5);x.globalAlpha=1}}
 x.strokeStyle=col;x.lineWidth=5;x.beginPath();for(let i=0;i<=16;i++)x.lineTo(i*16,200+Math.sin(i*.9)*40+i*-4);x.stroke();
 const t=new T.CanvasTexture(c);t.colorSpace=T.SRGBColorSpace;t.wrapT=T.RepeatWrapping;t.repeat.set(1,.5);return t}
function station(k){const s=SPEC[k],g=new T.Group();g.position.set(s.x,0,-.6);g.rotation.y=Math.PI;g.userData.k=k;
 const wood=M('#ecd0a8',{roughness:.5}),white=M('#ffffff',{roughness:.4});
 g.add(mesh(new T.CapsuleGeometry(.07,2.85,4,8).rotateZ(Math.PI/2),wood,[0,1.5,-.78]));
 g.add(mesh(rbox(3,.12,1.5),wood,[0,1.5,0]));for(const a of[-1.35,1.35])for(const b of[-.6,.6])g.add(mesh(new T.CylinderGeometry(.05,.05,1.5),white,[a,.75,b]));
 const texs=[],mm=[];
 const pos=s.mons==3?[[-1.15,.95],[1.15,-.95],[0,0]]:[[-1.05,.95],[1.05,-.95]];
 pos.forEach(([px,ry],i)=>{const mon=new T.Group(),small=i==2;mon.position.set(px,1.56,small?-.45:-.15);mon.rotation.y=small?Math.PI:ry;mon.scale.setScalar(small?.38:.62);
  mon.add(mesh(new T.CylinderGeometry(.25,.28,.04,24),white,[0,.02,0]));mon.add(mesh(rbox(.07,.55,.07),white,[0,.3,0]));
  mon.add(mesh(rbox(1.5,.95,.07),M('#f6f4f0',{roughness:.35}),[0,.95,0]));
  const tx=scrTex(s.scr,k=='copy'&&i==1?1:0);texs.push(tx);const sm=new T.MeshStandardMaterial({color:'#ffffff',map:tx,emissive:'#ffffff',emissiveMap:tx,emissiveIntensity:.8,roughness:.3});mm.push(sm);
  for(const zz of[.04,-.04]){const sc=mesh(new T.PlaneGeometry(1.38,.82),sm,[0,.95,zz],false);if(zz<0)sc.rotation.y=Math.PI;mon.add(sc)}g.add(mon)});
 const sm={set emissiveIntensity(v){mm.forEach(m=>m.emissiveIntensity=v)}};
 const gl=new T.PointLight(s.scr,0,3.5,1.5);gl.position.set(0,2.3,.4);g.add(gl);
 g.add(mesh(rbox(.95,.04,.3),white,[0,1.58,.3]));
 const mug=new T.Group();mug.add(mesh(new T.CylinderGeometry(.1,.09,.22,16),M(s.scr),[0,.11,0]));const h=mesh(new T.TorusGeometry(.065,.02,8,16),M(s.scr),[.11,.12,0]);h.rotation.y=Math.PI/2;mug.add(h);mug.position.set(-.75,1.56,.45);g.add(mug);
 const stc=document.createElement('canvas');stc.width=stc.height=64;const sx2=stc.getContext('2d');const gr=sx2.createRadialGradient(32,32,2,32,32,30);gr.addColorStop(0,'rgba(255,255,255,.9)');gr.addColorStop(1,'rgba(255,255,255,0)');sx2.fillStyle=gr;sx2.fillRect(0,0,64,64);const stt=new T.CanvasTexture(stc);
 const steam=[0,1,2].map(()=>{const p=new T.Sprite(new T.SpriteMaterial({map:stt,transparent:true,depthWrite:false}));g.add(p);return p});
 const pp=plant(0,0,.4);S.remove(pp);pp.position.set(1.2,1.56,.5);g.add(pp);
 const chair=new T.Group();chair.position.set(0,0,1.15);const cm=M('#fdfaf4',{roughness:.5});chair.add(mesh(new T.CylinderGeometry(.06,.06,.7),M('#c8c2b8'),[0,.4,0]));chair.add(mesh(new T.CylinderGeometry(.5,.5,.05,6),M('#c8c2b8'),[0,.06,0]));
 chair.add(mesh(new T.CapsuleGeometry(.12,.85,4,12).rotateZ(Math.PI/2),cm,[0,.85,0]).translateX(0));chair.add(mesh(rbox(1.05,.16,.95),cm,[0,.85,0]));chair.add(mesh(rbox(1.05,1.05,.15),cm,[0,1.4,.46]));g.add(chair);
 // character (chibi)
 const ch=new T.Group();ch.position.set(0,.98,1.0);const fur=M(s.fur,{roughness:.9}),bel=M(s.belly,{roughness:.95}),dark=M('#2a2420',{roughness:.2}),pink=M('#ff9fb0',{roughness:.9,transparent:true,opacity:.8});
 const body=mesh(new T.SphereGeometry(.48,28,20),fur,[0,.5,0]);body.scale.set(1,1.05,.92);ch.add(body);
 const bl=mesh(new T.SphereGeometry(.34,20,14),bel,[0,.45,-.2]);bl.scale.set(1,1.1,.6);ch.add(bl);
 for(const sx of[-1,1]){const f=mesh(new T.SphereGeometry(.15,14,10),fur,[.22*sx,.08,-.32]);f.scale.set(1,.7,1.3);ch.add(f)}
 const head=new T.Group();head.position.set(0,1.38,0);ch.add(head);
 const hd=mesh(new T.SphereGeometry(.64,32,24),fur);hd.scale.set(1.1,.94,1);head.add(hd);
 const mz=mesh(new T.SphereGeometry(.26,20,14),bel,[0,-.2,-.5]);mz.scale.set(1.25,.8,.7);head.add(mz);
 for(const sx of[-1,1]){const e=mesh(new T.SphereGeometry(.085,16,12),dark,[.24*sx,.04,-.57]);e.scale.set(1,1.2,.6);head.add(e);head.add(mesh(new T.SphereGeometry(.028,8,6),M('#fff',{emissive:'#fff',emissiveIntensity:.6}),[.22*sx+.02,.08,-.62],false));
  const bk=mesh(new T.SphereGeometry(.1,14,10),pink,[.42*sx,-.16,-.46],false);bk.scale.set(1.2,.6,.4);head.add(bk)}
 const nose=mesh(new T.SphereGeometry(.05,10,8),M(s.ear=='bunny'?'#f58ea0':'#3a2c28'),[0,-.12,-.66]);nose.scale.set(1.2,.8,.8);head.add(nose);
 const mo=mesh(new T.TorusGeometry(.05,.012,6,12,Math.PI),dark,[0,-.23,-.63],false);mo.rotation.z=Math.PI;head.add(mo);
 const ears=[];for(const sx of[-1,1]){const p=new T.Group();let e,inn;
  if(s.ear=='bunny'){p.position.set(.22*sx,.5,.02);e=mesh(new T.CapsuleGeometry(.13,.78,8,14),fur,[0,.45,0]);e.scale.set(1,1,.6);inn=mesh(new T.CapsuleGeometry(.07,.6,6,10),pink,[0,.45,-.06]);inn.scale.set(1,1,.4);p.rotation.z=-.12*sx}
  else{p.position.set(.36*sx,.45,0);e=mesh(new T.ConeGeometry(.2,s.ear=='cat'?.36:.32,24),fur,[0,.12,0]);e.scale.set(1,1,.55);inn=mesh(new T.ConeGeometry(.11,.22,16),s.ear=='shiba'?bel:pink,[0,.09,-.06]);inn.scale.set(1,1,.4);p.rotation.z=-.32*sx}
  p.add(e,inn);head.add(p);ears.push(p);p.userData.sx=sx;p.userData.base=p.rotation.z}
 if(s.acc=='phones'){const pm=M('#2f3d5c',{roughness:.4}),cu=M('#ffffff',{roughness:.6});const band=mesh(new T.TorusGeometry(.68,.06,10,32,Math.PI),pm,[0,.05,0]);band.rotation.y=Math.PI/2;head.add(band);
  for(const sx of[-1,1]){const c=mesh(new T.CylinderGeometry(.22,.22,.14,24),pm,[.68*sx,-.02,0]);c.rotation.z=Math.PI/2;head.add(c);const q=mesh(new T.CylinderGeometry(.16,.16,.05,20),M('#4f9cf5',{emissive:'#4f9cf5',emissiveIntensity:.4}),[.76*sx,-.02,0]);q.rotation.z=Math.PI/2;head.add(q)}}
 if(s.acc=='scarf'){const red=M('#d93a44',{roughness:.85});const sc=mesh(new T.TorusGeometry(.38,.12,12,28),red,[0,.98,0]);sc.rotation.x=Math.PI/2;sc.scale.set(1,1,.9);ch.add(sc);const tl=mesh(new T.CapsuleGeometry(.08,.32,4,8),red,[.22,.72,-.36]);tl.rotation.z=.25;ch.add(tl);const tl2=mesh(new T.CapsuleGeometry(.08,.22,4,8),red,[.08,.76,-.4]);tl2.rotation.z=-.15;ch.add(tl2);
  for(const sx of[-1,1])head.add(mesh(new T.SphereGeometry(.13,12,10),bel,[.3*sx,-.3,-.38]))}
 if(s.ear=='bunny'){ch.add(mesh(new T.SphereGeometry(.17,14,10),bel,[0,.3,.45]))}
 if(s.ear=='cat'){const t=mesh(new T.TorusGeometry(.3,.07,8,20,Math.PI),fur,[0,.4,.5]);t.rotation.y=Math.PI/2;ch.add(t)}
 if(s.ear=='shiba'){const t=mesh(new T.TorusGeometry(.16,.09,10,20,Math.PI*1.6),fur,[0,.75,.5]);t.rotation.y=Math.PI/2;ch.add(t)}
 const arms=[];for(const sx of[-1,1]){const a=new T.Group();a.position.set(.42*sx,.78,-.05);const m=mesh(new T.CapsuleGeometry(.12,.32,8,12),fur,[0,-.22,0]);a.add(m);a.add(mesh(new T.SphereGeometry(.13,12,10),bel,[0,-.44,0]));a.rotation.x=-1.15;ch.add(a);arms.push(a)}
 g.add(ch);
 const zc=document.createElement('canvas');zc.width=zc.height=128;const zx=zc.getContext('2d');zx.font='bold 90px sans-serif';zx.fillStyle='#8c8378';zx.fillText('z',30,100);
 const zs=[0,1,2].map(i=>{const sp=new T.Sprite(new T.SpriteMaterial({map:new T.CanvasTexture(zc),transparent:true,depthWrite:false}));sp.scale.setScalar(.35);g.add(sp);return sp});
 const hit=new T.Mesh(rbox(3.2,3.6,3.4),new T.MeshBasicMaterial({visible:false}));hit.position.set(0,1.8,.5);hit.userData.k=k;g.add(hit);
 S.add(g);st[k]={gl,g,ch,head,ears,arms,sm,lines:[],texs,steam,zs,hit,busy:false,glow:.8,ph:Math.random()*9,bw:0}}
Object.keys(SPEC).forEach(station);
// ===== extra props + brands =====
const X=[];
const ctex=(w,h,draw)=>{const c=document.createElement('canvas');c.width=w;c.height=h;draw(c.getContext('2d'),w,h);const t=new T.CanvasTexture(c);t.colorSpace=T.SRGBColorSpace;t.anisotropy=4;return t};
const rr=(x,a,b,w,h,r)=>{x.beginPath();x.roundRect(a,b,w,h,r);x.fill()};
const panel=(tex,w,h,p,ry=0,em=.25)=>{const m=mesh(new T.PlaneGeometry(w,h),new T.MeshStandardMaterial({map:tex,emissive:'#ffffff',emissiveMap:tex,emissiveIntensity:em,roughness:.6}),p,false);m.rotation.y=ry;S.add(m);return m};
const BR=[{n:'GMGN',s:'Smart Money',c:'#1f2a24',a:'#7be37b'},{n:'Four.meme',s:'Launch · BSC',c:'#fff4dc',a:'#f5b52e'},{n:'Flap',s:'Bonding Curve',c:'#efe6ff',a:'#8b5cf6'},{n:'BINANCE',s:'Web3 Wallet',c:'#1e2026',a:'#f0b90b'}];
const poster=(b,ln)=>ctex(256,340,(x,w,h)=>{x.fillStyle='#fffaf1';x.fillRect(0,0,w,h);x.fillStyle=b.c;rr(x,14,14,w-28,h-28,18);x.fillStyle=b.a;x.beginPath();x.arc(w/2,110,52,0,7);x.fill();x.fillStyle=b.c;x.font='bold 54px sans-serif';x.textAlign='center';x.fillText(b.n[0],w/2,129);x.fillStyle=b.a;x.font='bold '+(b.n.length>6?34:40)+'px sans-serif';x.fillText(b.n,w/2,215);x.globalAlpha=.75;x.font='22px sans-serif';x.fillText(b.s,w/2,250);x.globalAlpha=1;x.lineWidth=4;x.strokeStyle=b.a;x.beginPath();for(let i=0;i<9;i++)x.lineTo(40+i*22,300-ln[i]);x.stroke()});
[[-2.5,5.05],[-2.5,3.35],[2.5,5.05],[2.5,3.35]].forEach(([px,py],i)=>{S.add(mesh(rbox(1.2,1.56,.06),M('#e6cfa8'),[px,py,-4.88],false));panel(poster(BR[i],[0,12,6,20,14,28,22,34,30].map(v=>v*(1+i*.15))),1.09,1.45,[px,py,-4.84])});
// ticker board
const tkC=document.createElement('canvas');tkC.width=1024;tkC.height=96;const tkX=tkC.getContext('2d');const tk=new T.CanvasTexture(tkC);tk.colorSpace=T.SRGBColorSpace;tk.wrapS=T.RepeatWrapping;
const tkTxt='  BNB ▲ 709.59   SOL ▼ 94.51   GMGN 🔥 Smart Money   FOUR.MEME 🚀 New Launch   FLAP ◆ Curve 62%   BINANCE ★ Web3   ';
function drawTk(){tkX.fillStyle='#2b2a33';tkX.fillRect(0,0,1024,96);tkX.font='bold 44px sans-serif';tkX.textBaseline='middle';let x=0;for(const part of tkTxt.split('   ')){tkX.fillStyle=/▼/.test(part)?'#ff7b7b':/BINANCE|FOUR/.test(part)?'#f5c34a':/FLAP/.test(part)?'#b79bff':'#7be3a0';tkX.fillText(part+'   ',x,50);x+=tkX.measureText(part+'   ').width}tk.needsUpdate=true}
drawTk();S.add(mesh(rbox(8.4,.62,.1),M('#d9c3a0'),[0,6.15,-4.88],false));const tkm=panel(tk,8.1,.5,[0,6.15,-4.82],0,.9);tk.repeat.set(.55,1);
X.push(t=>{tk.offset.x=(t*.04)%1});
window.O3D_TICK=s=>{/* hook for /api/live prices */};
// wall clock
const clock=new T.Group();clock.position.set(-7.6,6.1,-4.85);S.add(clock);clock.add(mesh(new T.CylinderGeometry(.55,.55,.08,40).rotateX(Math.PI/2),M('#f4a261'),[0,0,0],false));clock.add(mesh(new T.CylinderGeometry(.47,.47,.09,40).rotateX(Math.PI/2),M('#fffdf8'),[0,0,.01],false));
for(let i=0;i<12;i++)clock.add(mesh(rbox(.04,.09,.02),M('#7a6a58'),[Math.sin(i/12*6.283)*.39,Math.cos(i/12*6.283)*.39,.07],false));
const hand=(l,w,c)=>{const g=new T.Group();g.add(mesh(rbox(w,l,.02),M(c),[0,l/2,0],false));g.position.z=.08;clock.add(g);return g};const hH=hand(.24,.05,'#3a2c28'),hM=hand(.36,.035,'#3a2c28'),hS=hand(.4,.015,'#d93a44');
X.push(()=>{const d=new Date(),s=d.getSeconds()+d.getMilliseconds()/1e3,m=d.getMinutes()+s/60,h=d.getHours()%12+m/60;hS.rotation.z=-s/60*6.283;hM.rotation.z=-m/60*6.283;hH.rotation.z=-h/12*6.283});
// sunlight shafts + blinds
for(const x of[-5,0,5]){for(let j=0;j<6;j++)S.add(mesh(rbox(2.7,.05,.03),M('#fff8ec'),[x,5.15-j*.16,-4.78],false));
 const sh=mesh(new T.PlaneGeometry(2.2,6),new T.MeshBasicMaterial({color:'#fff3d6',transparent:true,opacity:.09,depthWrite:false,side:T.DoubleSide}),[x+.9,2.6,-3],false);sh.rotation.set(-.55,.0,-.25);S.add(sh)}
// pendant lamps
Object.values(SPEC).forEach(s=>{const g=new T.Group();g.position.set(s.x,6.9,-1.3);S.add(g);g.add(mesh(new T.CylinderGeometry(.01,.01,1.4),M('#8c7f70'),[0,-.7,0],false));const sh=mesh(new T.ConeGeometry(.42,.38,28,1,true),M('#fffaf0',{side:T.DoubleSide,emissive:'#ffe7b8',emissiveIntensity:.35}),[0,-1.55,0],false);g.add(sh);g.add(mesh(new T.SphereGeometry(.12,12,10),M('#fff3cf',{emissive:'#ffdf9a',emissiveIntensity:1.6}),[0,-1.68,0],false));const l=new T.PointLight('#ffdca0',.6,5,1.6);l.position.set(0,-1.8,0);g.add(l);X.push(t=>{g.rotation.z=Math.sin(t*.6+s.x)*.02})});
// name plaques + mouse + brand stickers on each desk
const ROLE={score:['唐僧','评分','BINANCE','#f0b90b'],risk:['沙僧','风控','GMGN','#57c56a'],copy:['悟空','跟单','Four','#f5b52e']};
for(const k in st){const s=st[k],[nm,rl,bd,bc]=ROLE[k];
 const pt=ctex(256,80,(x,w,h)=>{x.fillStyle='#fffaf1';rr(x,0,0,w,h,16);x.fillStyle=SPEC[k].scr;rr(x,8,8,64,64,12);x.fillStyle='#fff';x.font='bold 34px sans-serif';x.textAlign='center';x.fillText(nm[0],40,52);x.fillStyle='#3a2c28';x.textAlign='left';x.font='bold 36px sans-serif';x.fillText(nm+'·'+rl,86,54)});
 const pl=mesh(new T.PlaneGeometry(1.1,.34),new T.MeshStandardMaterial({map:pt,roughness:.5}),[0,1.32,-.765],false);pl.rotation.y=Math.PI;s.g.add(pl);
 const stk=ctex(128,128,(x)=>{x.fillStyle=bc;x.beginPath();x.arc(64,64,60,0,7);x.fill();x.fillStyle='#fff';x.font='bold '+(bd.length>4?24:34)+'px sans-serif';x.textAlign='center';x.fillText(bd,64,76)});
 const sk=mesh(new T.CircleGeometry(.17,24),new T.MeshStandardMaterial({map:stk,roughness:.5}),[1.05,1.12,-.765],false);sk.rotation.y=Math.PI;s.g.add(sk);
 const ms=mesh(new T.SphereGeometry(.08,12,8),M('#ffffff',{roughness:.3}),[.7,1.58,.32]);ms.scale.set(.75,.4,1.1);s.g.add(ms);
 s.g.add(mesh(rbox(.36,.01,.3),M(SPEC[k].scr,{roughness:.9}),[.7,1.565,.32],false));
 // HUD chip
 const hud=new T.Sprite(new T.SpriteMaterial({map:ctex(256,72,(x,w,h)=>{x.fillStyle='rgba(255,252,245,.95)';rr(x,2,2,w-4,h-4,34);x.fillStyle=SPEC[k].scr;x.beginPath();x.arc(36,36,12,0,7);x.fill();x.fillStyle='#3a2c28';x.font='bold 32px sans-serif';x.fillText({score:'评分 6 条',risk:'风控巡检',copy:'跟单监听'}[k],60,47)}),transparent:true,depthWrite:false}));hud.scale.set(1.5,.42,1);hud.position.set(s.g.position.x,4.55,-1.7);S.add(hud);
 X.push(t=>{hud.material.opacity=s.bw;hud.visible=s.bw>.05;hud.position.y=4.55+Math.sin(t*2+s.ph)*.06})}
// sticky notes near risk desk (wall below center window)
['#fff59d','#ffccbc','#c8e6c9','#bbdefb','#fff59d'].forEach((c,i)=>{const n=mesh(rbox(.42,.42,.01),M(c),[-1.1+i*.55,2.75+(i%2)*.35,-4.88],false);n.rotation.z=(i%3-1)*.12;S.add(n)});
// side table: printer + coffee machine (left)
const tb=new T.Group();tb.position.set(-7.4,0,0.6);S.add(tb);tb.add(mesh(rbox(1.8,.08,1.1),M('#ecd0a8'),[0,1.2,0]));for(const a of[-.8,.8])for(const b of[-.45,.45])tb.add(mesh(new T.CylinderGeometry(.04,.04,1.2),M('#fff'),[a,.6,b]));
tb.add(mesh(rbox(.75,.32,.55),M('#f3f1ec'),[-.4,1.4,0]));tb.add(mesh(rbox(.5,.02,.3),M('#ffffff'),[-.4,1.57,.12]));const led=mesh(rbox(.06,.04,.02),M('#3fd47a',{emissive:'#3fd47a',emissiveIntensity:1.5}),[-.15,1.45,.28],false);tb.add(led);
tb.add(mesh(rbox(.45,.65,.45),M('#2f3d5c'),[.45,1.56,0]));tb.add(mesh(rbox(.3,.12,.05),M('#f0b90b',{emissive:'#f0b90b',emissiveIntensity:.5}),[.45,1.7,.23],false));tb.add(mesh(new T.CylinderGeometry(.07,.06,.14,12),M('#fff'),[.45,1.31,.12]));
X.push(t=>{led.material.emissiveIntensity=1+Math.sin(t*4)});
// branded binders on a second shelf
S.add(mesh(rbox(3,.1,.5),M('#c9a37a'),[-7,1.7,-4.6]));BR.forEach((b,i)=>{for(let j=0;j<2;j++){const bx=mesh(rbox(.28,.62,.4),M(b.a),[-8.2+(i*2+j)*.32,2.06,-4.6]);S.add(bx)}});
// water cooler (right)
const wc=new T.Group();wc.position.set(7.6,0,0);S.add(wc);wc.add(mesh(rbox(.7,1.4,.7),M('#fbfaf6'),[0,.7,0]));wc.add(mesh(new T.CylinderGeometry(.3,.3,.75,20),M('#bfe3ff',{transparent:true,opacity:.75,roughness:.1}),[0,1.8,0]));wc.add(mesh(rbox(.12,.08,.05),M('#4f9cf5'),[0,1.1,.37]));
// shelf of brand cubes right wall area + more plants, cushions, bin
plant(-8.2,3.8,1.1);plant(5.6,-4.2,.8);plant(-5.6,-4.2,.8);
[['#f8bbd0',-5.2,3.2],['#90caf9',-4.3,3.8],['#f5b52e',5.2,3.6]].forEach(([c,x,z])=>{const cu=mesh(new T.CylinderGeometry(.45,.48,.22,24),M(c,{roughness:.95}),[x,.11,z]);cu.scale.set(1,1,.85);S.add(cu)});
const bin=mesh(new T.CylinderGeometry(.24,.2,.5,20,1,true),M('#c8c2b8',{side:T.DoubleSide}),[6.9,.25,1.6]);S.add(bin);
// monitor wallpaper brand accents
[['score','#f0b90b'],['risk','#7be37b'],['copy','#8b5cf6']].forEach(([k,c])=>{const s=st[k];const dot=mesh(new T.CircleGeometry(.05,16),M(c,{emissive:c,emissiveIntensity:1}),[0,2.3,-.12],false);dot.rotation.y=Math.PI;s.g.add(dot)});

// camera orbit
let yaw=0,pitch=.42,ty=0,tp=.42,dist=14,drag=null,moved=false;
function size(){const w=box.clientWidth,h=box.clientHeight;R.setSize(w,h,false);C.aspect=w/h;const a=w/h;C.fov=a<1?50:40;const hh=Math.tan(C.fov*Math.PI/360)*a;dist=Math.max(11,Math.min(32,(a<1?6.2:5.5)/hh));C.updateProjectionMatrix()}
new ResizeObserver(size).observe(box);size();
const el=R.domElement;el.style.touchAction='pan-y';
el.addEventListener('pointerdown',e=>{drag={x:e.clientX,y:e.clientY,yaw:ty,p:tp,id:e.pointerId};moved=false});
el.addEventListener('pointermove',e=>{if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.hypot(dx,dy)>6)moved=true;if(moved){ty=Math.max(-.7,Math.min(.7,drag.yaw-dx*.005));tp=Math.max(.15,Math.min(.85,drag.p+dy*.004))}});
const rc=new T.Raycaster(),pt=new T.Vector2();
el.addEventListener('pointerup',e=>{const d=drag;drag=null;if(!d||moved)return;const r=el.getBoundingClientRect();pt.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);rc.setFromCamera(pt,C);const h=rc.intersectObjects(Object.values(st).map(s=>s.hit))[0];if(h)location.hash=h.object.userData.k});
el.addEventListener('pointerleave',()=>drag=null);
window.O3D={update(m){for(const k in m)if(st[k])st[k].busy=!!m[k]}};window.dispatchEvent(new Event('o3d-ready'));
const clk=new T.Clock();
(function loop(){const t=clk.getElapsedTime();yaw+=(ty+(drag?0:Math.sin(t*.25)*.08)-yaw)*.06;pitch+=(tp-pitch)*.06;
 C.position.set(Math.sin(yaw)*dist*Math.cos(pitch),1.6+Math.sin(pitch)*dist,Math.cos(yaw)*dist*Math.cos(pitch)+.5);C.lookAt(0,1.9,-1.1);
 for(const k in st){const s=st[k],q=t+s.ph,b=s.busy;s.bw+=((b?1:0)-s.bw)*.04;const w=s.bw;
  s.glow+=((b?1.25+Math.sin(q*3)*.15:.3)-s.glow)*.05;s.sm.emissiveIntensity=s.glow;s.gl.intensity=s.glow*1.4;
  s.texs.forEach((x,i)=>{if(b)x.offset.y=(x.offset.y+.0015*(1+i*.4))%1});
  s.arms.forEach((a,i)=>{const ty=Math.sin(q*11+i*Math.PI)*.14*(.7+.3*Math.sin(q*.7));a.rotation.x=-1.15*w+(-.35)*(1-w)+ty*w;a.rotation.z=(i?-.12:.12)*(1-w)});
  s.head.rotation.x=w*(Math.sin(q*2)*.06+.05)+(1-w)*(.3+Math.sin(q*.6)*.06);s.head.rotation.z=w*Math.sin(q*1.1)*.07+(1-w)*.14;s.head.rotation.y=w*Math.sin(q*.37)*.18;s.head.position.y=1.38+w*Math.abs(Math.sin(q*3))*.025-(1-w)*.07;
  const tw=Math.max(0,Math.sin(q*1.3))**24;s.ears.forEach(e=>e.rotation.z=e.userData.base+tw*.4*e.userData.sx*(.4+.6*w));
  const br=Math.sin(q*(1+w*.8))*.025;s.ch.scale.set(1-br*.4,1+br,1-br*.4);
  s.steam.forEach((p,i)=>{const u=(t*.4+i/3)%1;p.position.set(-.75+Math.sin(u*6+i)*.05,1.85+u*.6,.45);p.material.opacity=Math.sin(u*Math.PI)*.55;p.scale.setScalar(.12+u*.18)});
  s.zs.forEach((z,i)=>{z.visible=w<.5;const u=((t*.35+i/3)%1);z.position.set(-.3-u*.6,3.2+u*1.1,1);z.material.opacity=Math.sin(u*Math.PI)*(1-w);z.scale.setScalar(.2+u*.3)})}
 X.forEach(f=>f(t));R.render(S,C);requestAnimationFrame(loop)})();
