const path=require("node:path"),os=require("node:os"),fss=require("node:fs");
process.env.BOT_DATA_DIR=fss.mkdtempSync(path.join(os.tmpdir(),"dexvra-why-"));
const test=require("node:test");
const market=require("../src/marketdata"),api=require("../src/api/dexvra"),autoTrend=require("../src/services/autoTrend");
const watch=require("../src/services/trendingWatch");
const listing=(a,c="solana")=>({status:"approved",chain:c,address:a,sym:a,trendingRank:null});

test("26 spares: 25 real markets in free-fall + 1 unprobed tail", async ()=>{
  await autoTrend.reset();
  await autoTrend.set({enabled:true,chains:["solana"],perChainMin:5,perChainMax:5,minGainPct:0,
    announce:false,fillFromMarket:false,minMcapUsd:100_000,minVol24hUsd:10_000});
  const falling={priceUsd:1,mcap:20_000_000,vol24h:5_000_000,change24h:-40};
  const rm=market.fetchMarket,rl=api.getListings,rb=api.bookTrending;
  market.fetchMarket=async()=>falling;
  api.getListings=async()=>Array.from({length:26},(_,i)=>listing("T"+i));
  api.bookTrending=async()=>{};
  try{ await autoTrend.runOnce({rng:()=>0.5}); }
  finally{market.fetchMarket=rm;api.getListings=rl;api.bookTrending=rb;}
});

test("diagnose: 1 tail refusal outranks the real cause", ()=>{
  console.log(JSON.stringify(watch.diagnose({featured:0,floor:5,eligible:26,floorRefused:1,
    minMcapUsd:100_000,minVol24hUsd:10_000}),null,1));
});
