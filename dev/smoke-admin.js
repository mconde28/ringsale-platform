/* RingSale owner-admin smoke test — headless DOM stubs + in-memory Supabase fake.
   Mirrors dev/smoke.js: mkEl/byId/global.document, fake chainable query builder
   (from/select/eq/gte/order/limit/insert/update/delete/single/maybeSingle —
   all thenable), extended with vendors + profiles tables, update()/delete()
   support, a per-call ops log, and SB/Auth/Register stubs.
   Covers: admin routing + vendor list (HQ excluded), suspended routing,
   active-owner routing, suspend / reactivate / delete actions, tenant
   isolation, revenue aggregates, logout teardown of both modules, no-status
   default routing, and the show/hide password toggles. */
function mkEl(){
  var el={
    innerHTML:'',textContent:'',hidden:false,title:'',value:'',id:'',type:'',
    style:{setProperty(){}},
    classList:{toggle(){},add(){},remove(){},contains(){return false;}},
    _handlers:{},_attrs:{},
    addEventListener:function(t,fn){(this._handlers[t]=this._handlers[t]||[]).push(fn);},
    appendChild(){},insertBefore(){},remove(){},
    setAttribute:function(k,v){this._attrs[k]=String(v);},
    getAttribute:function(k){return Object.prototype.hasOwnProperty.call(this._attrs,k)?this._attrs[k]:null;},
    querySelector(){return mkEl();},querySelectorAll(){return[];},
    parentNode:null,disabled:false,checked:false
  };
  return el;
}
var byId={};
function elById(id){return byId[id]||(byId[id]=mkEl());}
var domReady=[];
/* The two show/hide password toggles from index.html (class pw-toggle,
   data-pw-for = login-password / signup-password). */
var pwToggleLogin=mkEl();
pwToggleLogin.setAttribute('data-pw-for','login-password');
pwToggleLogin.setAttribute('aria-label','Show password');
pwToggleLogin.setAttribute('aria-pressed','false');
var pwToggleSignup=mkEl();
pwToggleSignup.setAttribute('data-pw-for','signup-password');
pwToggleSignup.setAttribute('aria-label','Show password');
pwToggleSignup.setAttribute('aria-pressed','false');
var pwToggles=[pwToggleLogin,pwToggleSignup];
global.document={
  getElementById:function(id){return elById(id);},
  querySelector:function(s){
    if(s.charAt(0)==='#')return elById(s.slice(1));
    return mkEl();
  },
  querySelectorAll:function(s){
    if(s==='.pw-toggle')return pwToggles;
    return[];
  },
  addEventListener:function(t,fn){if(t==='DOMContentLoaded')domReady.push(fn);},
  createElement:function(){return mkEl();},
  body:mkEl(),documentElement:mkEl()
};
global.window={addEventListener(){}};
global.navigator={};
global.setInterval=function(){return 0;};
global.clearInterval=function(){};
global.confirm=function(){return true;};
global.prompt=function(){return null;};
global.localStorage={
  _s:{},
  getItem(k){return Object.prototype.hasOwnProperty.call(this._s,k)?this._s[k]:null;},
  setItem(k,v){this._s[k]=String(v);},
  removeItem(k){delete this._s[k];}
};
/* Password inputs start as type=password, like index.html. */
elById('login-password').type='password';
elById('signup-password').type='password';

/* In-memory fake of the Supabase JS v2 query builder. Same structure as
   dev/smoke.js, extended with: vendors + profiles tables, limit(),
   maybeSingle(), update()/delete() (mirrored), an _ops log of every
   executed call {table, mode, eqs, payload}, and tracked eq conditions. */
function makeFakeSupabase(){
  var tables={
    vendors:[
      {id:'v-hq',name:'RingSale HQ',phone:'555-0000',status:'active',is_hq:true,created_at:'2026-09-01T09:00:00Z'},
      {id:'v-hq2',name:'RingSale HQ',phone:'555-0001',status:'active',is_hq:false,created_at:'2026-09-02T09:00:00Z'},
      {id:'v1',name:'Taco Libre',phone:'555-1111',status:'active',is_hq:false,created_at:'2026-09-10T09:00:00Z'},
      {id:'v2',name:'Elote Express',phone:'555-2222',status:'suspended',is_hq:false,created_at:'2026-09-12T09:00:00Z'},
      {id:'v3',name:'Jarritos Cart',phone:'555-3333',status:'active',is_hq:false,created_at:'2026-09-15T09:00:00Z'}
    ],
    profiles:[
      {user_id:'u-admin',vendor_id:null,role:'admin'}
    ],
    sales:[
      {id:'s1',vendor_id:'v1',total:12.00,created_at:'2026-10-01T10:00:00Z',tender:'Cash',lines:[{qty:1,name:'Taco',total:3.5}]},
      {id:'s2',vendor_id:'v1',total:18.50,created_at:'2026-10-03T12:00:00Z',tender:'Card',lines:[{qty:2,name:'Birria Taco',total:7}]},
      {id:'s3',vendor_id:'v2',total:5.00,created_at:'2026-10-02T11:00:00Z',tender:'Cash',lines:[{qty:1,name:'Elote',total:5}]}
    ],
    menu_items:[
      {id:'mi1',vendor_id:'v1',name:'Mango Jarritos',category:'Drinks',price:2.50,stock:48,avail:true,position:2},
      {id:'mi2',vendor_id:'v1',name:'Birria Taco',category:'Tacos',price:3.50,stock:60,avail:true,position:1}
    ],
    closed_days:[
      {id:'cd1',vendor_id:'v1',day:'2026-10-01',drawer:{loc:'Main Stall'},sales:[{total:12}],created_at:'2026-10-01T21:00:00Z'}
    ],
    drawer_state:[]
  };
  var seq=1;
  var client={
    offline:false,
    _ops:[],
    from:function(table){
      var rows=tables[table];
      var b={
        _filters:[],_eqs:[],_order:null,_limit:null,_mode:'select',_payload:null,_single:false,_maybe:false,
        select(){return this;},
        eq:function(c,v){this._eqs.push({c:c,v:v});this._filters.push(function(r){return r[c]===v;});return this;},
        gte:function(c,v){this._filters.push(function(r){return r[c]>=v;});return this;},
        order:function(c,o){this._order={c:c,asc:!o||o.ascending!==false};return this;},
        limit:function(n){this._limit=n;return this;},
        insert:function(p){this._mode='insert';this._payload=Array.isArray(p)?p:[p];return this;},
        update:function(p){this._mode='update';this._payload=p;return this;},
        delete:function(){this._mode='delete';return this;},
        single:function(){this._single=true;return this;},
        maybeSingle:function(){this._single=true;this._maybe=true;return this;},
        then:function(res,rej){
          try{
            if(client.offline)return res({data:null,error:{message:'network unreachable'}});
            var data=null,error=null;
            var self=this;
            var match=function(r){return self._filters.every(function(f){return f(r);});};
            if(this._mode==='select'){
              data=rows.filter(match);
              if(this._order){var c=this._order.c,asc=this._order.asc;
                data=data.slice().sort(function(a,b){return asc?(a[c]>b[c]?1:-1):(a[c]<b[c]?1:-1);});}
              if(this._limit!=null)data=data.slice(0,this._limit);
              if(this._single){data=data[0]||null;if(!data&&!this._maybe)error={code:'PGRST116',message:'no rows'};}
            }else if(this._mode==='insert'){
              data=this._payload.map(function(r){
                var n=Object.assign({id:'id-'+(seq++)},r);
                rows.push(n);return n;
              });
              if(this._single)data=data[0];
            }else if(this._mode==='update'){
              data=rows.filter(match).map(function(r){return Object.assign(r,self._payload);});
              if(this._single)data=data[0]||null;
            }else if(this._mode==='delete'){
              data=rows.filter(match);
              data.forEach(function(r){rows.splice(rows.indexOf(r),1);});
            }
            client._ops.push({table:table,mode:this._mode,eqs:this._eqs.slice(),payload:this._payload});
            res({data:data,error:error});
          }catch(e){rej(e);}
        }
      };
      return b;
    },
    _tables:tables
  };
  return client;
}

/* Auth/session stubs. scenario drives what syncAuthState sees. */
var scenario={user:null,role:'owner',vendor:null,vendorId:null};
function setScenario(user,role,vendor){
  scenario.user=user||null;
  scenario.role=role||'owner';
  scenario.vendor=vendor||null;
  scenario.vendorId=(vendor&&vendor.id)||null;
  window.Register.initCalls=[];
}
var fake=makeFakeSupabase();
window.SB={
  client:fake,
  configured:true,
  ready:Promise.resolve(),
  getUser:function(){return scenario.user;},
  getRole:function(){return scenario.role;},
  getVendor:function(){return scenario.vendor||{id:null,name:'',status:'active',is_hq:false};},
  getVendorId:function(){return scenario.vendorId;},
  refreshProfile:async function(){return scenario.vendorId;}
};
window.Auth={
  onAuthChange:function(cb){this._cb=cb;},
  signIn:async function(){return{};},
  signUp:async function(){return{};},
  signOut:async function(){setScenario(null,'owner',null);}
};
window.Register={
  initCalls:[],teardownCalls:0,
  init:async function(v){this.initCalls.push(v);},
  teardown:async function(){this.teardownCalls++;}
};

var fs=require('fs');
var driver=`
;(async function(){
var results=[];
function check(name,cond){results.push(!!cond);console.log((cond?'PASS':'FAIL')+' — '+name);}
function flush(){return new Promise(function(r){setTimeout(r,25);});}
async function boot(){var h=domReady[domReady.length-1];h.call(document);await flush();await flush();}
function lastHandler(el,t){var hs=el._handlers[t]||[];return hs[hs.length-1];}
function fire(el,t,evt){var h=lastHandler(el,t);if(!h)throw new Error('no '+t+' handler');return h.call(el,evt||{target:el,preventDefault:function(){}});}
function rowClick(vid){return fire(byId['admin-vendor-list'],'click',{target:{closest:function(){return{getAttribute:function(){return vid;}};}}});}
function vendorRow(id){return fake._tables.vendors.filter(function(v){return v.id===id;})[0];}
function lastOp(mode,table){var ops=fake._ops.filter(function(o){return o.mode===mode&&(!table||o.table===table);});return ops[ops.length-1];}

/* Count Admin.teardown calls without changing its behavior. */
var adminTeardownCalls=0;
var _adminTeardown=window.Admin.teardown;
window.Admin.teardown=function(){adminTeardownCalls++;return _adminTeardown();};

/* ---------- 1. admin routing + vendor list ---------- */
setScenario({id:'u-admin'},'admin',null);
await boot();
check('admin profile routes to screen-admin',
  byId['screen-admin'].hidden===false&&byId['screen-auth'].hidden===true&&
  byId['screen-app'].hidden===true&&byId['screen-suspended'].hidden===true);
var listHTML=byId['admin-vendor-list'].innerHTML;
var rows=(listHTML.match(/class="admin-vrow"/g)||[]).length;
check('vendor list excludes HQ rows (3 rows, no RingSale HQ)',
  rows===3&&!listHTML.includes('RingSale HQ')&&listHTML.includes('Taco Libre'));
check('suspended vendor shows suspended badge', listHTML.includes('badge suspended'));
check('active vendors show active badge', listHTML.includes('badge active'));

/* ---------- 8. list aggregates ---------- */
check('v1 revenue sums to $30.50', listHTML.includes('$30.50'));
check('v1 shows "2 sales"', listHTML.includes('2 sales'));
check('v1 last sale date Oct 3, 2026', listHTML.includes('Oct 3, 2026'));
check('v2 shows $5.00 and 1 sale', listHTML.includes('$5.00')&&listHTML.includes('1 sale'));

/* ---------- 7. tenant isolation at the query layer ---------- */
var r1=await fake.from('sales').select('*').eq('vendor_id','v1');
check('vendor-scoped sales query returns only own rows',
  r1.data.length===2&&r1.data.every(function(s){return s.vendor_id==='v1';}));
var rAll=await fake.from('sales').select('vendor_id, total, created_at');
check('admin aggregate query sees every vendor\\'s rows', rAll.data.length===3);

/* ---------- detail view via row click ---------- */
await rowClick('v1');await flush();
check('row click renders detail view',
  byId['admin-detail'].hidden===false&&!!lastHandler(byId['admin-btn-suspend'],'click'));
var menuHTML=byId['admin-detail-menu'].innerHTML;
check('detail menu is read-only and ordered by position',
  menuHTML.indexOf('Birria Taco')>-1&&menuHTML.indexOf('Birria Taco')<menuHTML.indexOf('Mango Jarritos'));
var salesHTML=byId['admin-detail-sales'].innerHTML;
check('detail shows itemized recent sales',
  salesHTML.includes('2 \\u00d7 Birria Taco')&&salesHTML.includes('tender: Cash'));
check('detail shows closed days',
  byId['admin-detail-closed'].innerHTML.includes('Main Stall'));

/* ---------- 4. suspend ---------- */
global.confirm=function(){return true;};
await fire(byId['admin-btn-suspend'],'click');await flush();
var v1=vendorRow('v1');
var upOp=lastOp('update','vendors');
check('suspend issues update status=suspended + suspended_at set',
  v1.status==='suspended'&&typeof v1.suspended_at==='string'&&v1.suspended_at.length>0&&
  upOp&&upOp.payload.status==='suspended'&&typeof upOp.payload.suspended_at==='string'&&
  upOp.eqs.some(function(e){return e.c==='id'&&e.v==='v1';}));

/* ---------- 5. reactivate ---------- */
await rowClick('v2');await flush();
check('suspended vendor detail shows reactivate button', !!lastHandler(byId['admin-btn-reactivate'],'click'));
await fire(byId['admin-btn-reactivate'],'click');await flush();
var v2=vendorRow('v2');
var upOp2=lastOp('update','vendors');
check('reactivate issues update status=active, suspended_at=null',
  v2.status==='active'&&v2.suspended_at===null&&
  upOp2&&upOp2.payload.status==='active'&&upOp2.payload.suspended_at===null&&
  upOp2.eqs.some(function(e){return e.c==='id'&&e.v==='v2';}));

/* ---------- 6. delete confirmation ---------- */
await rowClick('v3');await flush();
global.prompt=function(){return 'Wrong Name';};
await fire(byId['admin-btn-delete'],'click');await flush();
var delOpsV3=function(){return fake._ops.filter(function(o){
  return o.mode==='delete'&&o.table==='vendors'&&o.eqs.some(function(e){return e.v==='v3';});});};
check('delete with wrong name deletes nothing', !!vendorRow('v3')&&delOpsV3().length===0);
global.prompt=function(){return 'Jarritos Cart';};
await fire(byId['admin-btn-delete'],'click');await flush();
check('delete with exact name issues delete().eq(id, vid)',
  !vendorRow('v3')&&delOpsV3().length===1);

/* ---------- 2. suspended vendor routing ---------- */
setScenario({id:'u2'},'owner',{id:'v2',name:'Elote Express',status:'suspended'});
await boot();
check('suspended vendor routes to screen-suspended',
  byId['screen-suspended'].hidden===false&&byId['screen-app'].hidden===true);
check('Register.init is NOT called for suspended vendor', window.Register.initCalls.length===0);

/* ---------- 3. active owner routing ---------- */
setScenario({id:'u1'},'owner',{id:'v1',name:'Taco Libre',status:'active'});
await boot();
check('active owner routes to register screen',
  byId['screen-app'].hidden===false&&byId['screen-suspended'].hidden===true);
check('Register.init called with vendor id',
  window.Register.initCalls.length===1&&window.Register.initCalls[0]==='v1');

/* ---------- 10. missing status defaults to active ---------- */
setScenario({id:'u9'},'owner',{id:'v9',name:'No Status Co'});
await boot();
check('vendor row without status defaults to active (register, not suspended)',
  byId['screen-app'].hidden===false&&byId['screen-suspended'].hidden===true&&
  window.Register.initCalls.length===1&&window.Register.initCalls[0]==='v9');

/* ---------- 9. logout tears down both modules ---------- */
setScenario({id:'u-admin'},'admin',null);
await boot();
var rt0=window.Register.teardownCalls,at0=adminTeardownCalls;
await fire(byId['btn-logout'],'click');await flush();await flush();
check('logout calls Register.teardown', window.Register.teardownCalls===rt0+1);
check('logout calls Admin.teardown', adminTeardownCalls===at0+1);
check('logout routes back to screen-auth', byId['screen-auth'].hidden===false);

/* ---------- password toggles ---------- */
var tglL=pwToggles[0],tglS=pwToggles[1];
check('login password starts as type=password', byId['login-password'].type==='password');
fire(tglL,'click');
check('login toggle flips password→text', byId['login-password'].type==='text');
check('login toggle updates aria-pressed/aria-label/title',
  tglL.getAttribute('aria-pressed')==='true'&&tglL.getAttribute('aria-label')==='Hide password'&&
  tglL.getAttribute('title')==='Hide password');
fire(tglL,'click');
check('login toggle flips text→password and restores aria',
  byId['login-password'].type==='password'&&tglL.getAttribute('aria-pressed')==='false'&&
  tglL.getAttribute('aria-label')==='Show password');
fire(tglS,'click');
check('signup toggle flips password→text', byId['signup-password'].type==='text');
check('signup toggle updates aria-pressed/aria-label',
  tglS.getAttribute('aria-pressed')==='true'&&tglS.getAttribute('aria-label')==='Hide password');
fire(tglS,'click');
check('signup toggle flips text→password', byId['signup-password'].type==='password'&&
  tglS.getAttribute('aria-pressed')==='false');

var fails=results.filter(function(r){return !r;}).length;
console.log(fails?('RESULT: '+fails+' FAILURES'):'RESULT: ALL PASS');
process.exit(fails?1:0);
})();
`;
eval(fs.readFileSync(__dirname+'/../js/admin.js','utf8')+fs.readFileSync(__dirname+'/../js/app.js','utf8')+driver);
