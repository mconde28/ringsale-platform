/* RingSale register smoke test — headless DOM stubs + in-memory Supabase fake. */
function mkEl(){
  return {
    innerHTML:'',textContent:'',hidden:false,title:'',value:'',id:'',
    style:{setProperty(){}},
    classList:{toggle(){},add(){},remove(){},contains(){return false;}},
    addEventListener(){},appendChild(){},insertBefore(){},remove(){},setAttribute(){},
    querySelector(){return mkEl();},querySelectorAll(){return[];},
    parentNode:null,disabled:false,checked:false
  };
}
const els={};
global.document={
  querySelector(s){return els[s]||(els[s]=mkEl());},
  querySelectorAll(){return[];},
  addEventListener(){},createElement(){return mkEl();},
  body:mkEl(),documentElement:mkEl()
};
global.window={addEventListener(){}};
global.navigator={};
global.localStorage={
  _s:{},
  getItem(k){return Object.prototype.hasOwnProperty.call(this._s,k)?this._s[k]:null;},
  setItem(k,v){this._s[k]=String(v);},
  removeItem(k){delete this._s[k];}
};

/* In-memory fake of the Supabase JS v2 query builder. Supports the chainable
   methods register.js uses: from/select/eq/gte/order/insert/update/delete/
   upsert/single — all thenable like the real client. */
function makeFakeSupabase(){
  const tables={
    menu_items:[
      {id:'m1',vendor_id:'v-test',name:'Birria Taco',category:'Tacos',price:3.50,stock:60,avail:true,position:1},
      {id:'m2',vendor_id:'v-test',name:'Mango Jarritos',category:'Drinks',price:2.50,stock:48,avail:true,position:2},
      {id:'m3',vendor_id:'v-test',name:'Elote (Street Corn)',category:'Sides',price:4.50,stock:30,avail:true,position:3}
    ],
    sales:[],closed_days:[],drawer_state:[]
  };
  let seq=1;
  const client={
    offline:false,
    from(table){
      const rows=tables[table];
      const b={
        _filters:[],_order:null,_mode:'select',_payload:null,_upsertOpts:null,_single:false,
        select(){return this;},
        eq(c,v){this._filters.push(function(r){return r[c]===v;});return this;},
        gte(c,v){this._filters.push(function(r){return r[c]>=v;});return this;},
        order(c,o){this._order={c:c,asc:!o||o.ascending!==false};return this;},
        insert(p){this._mode='insert';this._payload=Array.isArray(p)?p:[p];return this;},
        update(p){this._mode='update';this._payload=p;return this;},
        delete(){this._mode='delete';return this;},
        upsert(p,o){this._mode='upsert';this._payload=p;this._upsertOpts=o||{};return this;},
        single(){this._single=true;return this;},
        then(res,rej){
          try{
            if(client.offline)return res({data:null,error:{message:'network unreachable'}});
            let data=null,error=null;
            const self=this;
            const match=function(r){return self._filters.every(function(f){return f(r);});};
            if(this._mode==='select'){
              data=rows.filter(match);
              if(this._order){const c=this._order.c,asc=this._order.asc;
                data=data.slice().sort(function(a,b){return asc?(a[c]>b[c]?1:-1):(a[c]<b[c]?1:-1);});}
              if(this._single){data=data[0]||null;if(!data)error={code:'PGRST116',message:'no rows'};}
            }else if(this._mode==='insert'){
              data=this._payload.map(function(r){
                const n=Object.assign({id:'id-'+(seq++)},r);
                if((table==='sales'||table==='closed_days')&&!n.created_at)n.created_at=new Date().toISOString();
                rows.push(n);return n;
              });
              if(this._single)data=data[0];
            }else if(this._mode==='update'){
              data=rows.filter(match).map(function(r){return Object.assign(r,self._payload);});
              if(this._single)data=data[0]||null;
            }else if(this._mode==='delete'){
              data=rows.filter(match);
              data.forEach(function(r){rows.splice(rows.indexOf(r),1);});
            }else if(this._mode==='upsert'){
              const conf=(this._upsertOpts.onConflict||'id').split(',')[0];
              const key=this._payload[conf];
              const ex=rows.find(function(r){return r[conf]===key;});
              if(ex){Object.assign(ex,this._payload);data=[ex];}
              else{const n=Object.assign({id:'id-'+(seq++)},this._payload);rows.push(n);data=[n];}
              if(this._single)data=data[0];
            }
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

const fs=require('fs');
const driver=`
;(async function(){
const results=[];
function check(name,cond){results.push(!!cond);console.log((cond?'PASS':'FAIL')+' — '+name);}
const fake=makeFakeSupabase();
global.window.SB={client:fake};

await window.Register.init('v-test');

// 1. menu renders from Supabase
const mg=document.querySelector('#menu-grid').innerHTML;
check('init renders menu from Supabase', mg.includes('Birria Taco')&&mg.includes('Mango Jarritos')&&mg.includes('Elote'));

// 2-3. tap-add a menu item -> ticket has 1 line
await menuTap('m1');
check('tap item opens customize modal', document.querySelector('#modal-box').innerHTML.length>0);
addToTicket();
check('tap-add creates 1 ticket line', ticket.length===1&&ticket[0].itemId==='m1');

// 4-6. complete a cash sale
const tot=ticketTotal();
await completeSale('Cash',20,R(20-tot));
check('cash sale inserts 1 sales row', fake._tables.sales.length===1);
const m1=fake._tables.menu_items.find(function(i){return i.id==='m1';});
check('cash sale decrements stock in Supabase (60->59)', m1.stock===59);
check('ticket cleared after sale', ticket.length===0);

// 7-8. zero stock -> greyed + tap blocked
await DB.updateItem('m2',{stock:0});
MENU.find(function(i){return i.id==='m2';}).stock=0;
renderMenu();
const mg2=document.querySelector('#menu-grid').innerHTML;
check('zero-stock item greyed with "Out of stock"', mg2.includes('menu-item out')&&mg2.includes('Out of stock'));
await menuTap('m2');
check('tap on out-of-stock item is blocked', ticket.length===0);

// 9-11. close day
openCloseDay();
document.querySelector('#cd-loc').value='Main Stall';
await confirmCloseDay();
check('close day writes 1 closed_days row', fake._tables.closed_days.length===1);
check('close day drawer snapshot has cash sales', fake._tables.closed_days[0].drawer.cashSales===3.5);
check('close day clears today sales in Supabase', fake._tables.sales.length===0);
check('close day lands on closed-day view', viewingClosed===0);

// 12-14. offline sale queues, then flushes on reconnect
fake.offline=true;
await menuTap('m3');addToTicket();
const t2=ticketTotal();
await completeSale('Cash',10,R(10-t2));
const q=JSON.parse(global.localStorage.getItem('ringsale-v1-queue-v-test')||'[]');
check('offline sale queued in localStorage', q.length===1&&fake._tables.sales.length===0);
check('offline badge shown', !!_made['#offline-badge']);
fake.offline=false;
const left=await flushQueue();
check('queue flushes on reconnect (1 sales row)', left===0&&fake._tables.sales.length===1);
const m3=fake._tables.menu_items.find(function(i){return i.id==='m3';});
check('flushed sale decrements stock (30->29)', m3.stock===29);

// 15. reports render
renderReports();
check('reports render', document.querySelector('#reports-body').innerHTML.includes('Gross sales'));

const fails=results.filter(function(r){return !r;}).length;
console.log(fails?('RESULT: '+fails+' FAILURES'):'RESULT: ALL PASS');
process.exit(fails?1:0);
})();
`;
eval(fs.readFileSync(__dirname+'/../js/register.js','utf8')+driver);
