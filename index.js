import * as dotenv from "dotenv";
dotenv.config();

import {
  createPublicClient,
  http,
  parseAbiItem,
  isAddress,
  getAddress,
} from "viem";
import { createClient } from "@supabase/supabase-js";

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL;
const LAUNCHPAD_CA = process.env.NEXT_PUBLIC_TOKEN_FACTORY_LOCALHOST;

const ROUTER_CA =
  process.env.NEXT_PUBLIC_ROUTER_ADDRESS ||
  process.env.NEXT_PUBLIC_ROUTER ||
  process.env.NEXT_PUBLIC_ROUTER_CA;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

// how many recent blocks to backfill on startup
const BACKFILL_BLOCKS = Number(process.env.BACKFILL_BLOCKS ?? 20000);
// chunk size per getLogs call (avoid RPC limits)
const BACKFILL_CHUNK = Number(process.env.BACKFILL_CHUNK ?? 2000);

function reqEnv(name, val) {
  if (!val) {
    console.error(`❌ Missing env: ${name}`);
    process.exit(1);
  }
  return val;
}

reqEnv("NEXT_PUBLIC_RPC_URL", RPC_URL);
reqEnv("NEXT_PUBLIC_TOKEN_FACTORY_LOCALHOST", LAUNCHPAD_CA);
reqEnv("NEXT_PUBLIC_ROUTER_ADDRESS", ROUTER_CA);
reqEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
reqEnv("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_KEY);

if (!isAddress(LAUNCHPAD_CA)) {
  console.error("❌ LAUNCHPAD_CA invalid:", LAUNCHPAD_CA);
  process.exit(1);
}
if (!isAddress(ROUTER_CA)) {
  console.error("❌ ROUTER_CA invalid:", ROUTER_CA);
  process.exit(1);
}

const launchpadAddr = getAddress(LAUNCHPAD_CA);
const routerAddr = getAddress(ROUTER_CA);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const client = createPublicClient({
  transport: http(RPC_URL),
  pollingInterval: 2000,
});

// ---------- Launchpad events (trades) ----------
const buyEvent = parseAbiItem(
  "event TokensBought(address indexed token, address indexed buyer, uint256 amountInUsd, uint256 amountOutToken)"
);
const sellEvent = parseAbiItem(
  "event TokensSold(address indexed token, address indexed seller, uint256 amountInToken, uint256 amountOutUsd)"
);

// ---------- Router read ABI (minimal) ----------
const routerReadAbi = [
  {
    type: "function",
    name: "factory",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
];

// ---------- Factory read ABI ----------
const factoryReadAbi = [
  {
    type: "function",
    name: "allPairsLength",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allPairs",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "address" }],
  },
];

// ---------- Pair ABI/events ----------
const pairSwapEvent = parseAbiItem(
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)"
);

const pairTokenAbi = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];

// ---------- helpers ----------
const blockTsCache = new Map(); // blockNumber(bigint)->timestamp(number)
async function getBlockTimestamp(blockNumber) {
  if (!blockNumber) return null;
  const k = blockNumber.toString();
  if (blockTsCache.has(k)) return blockTsCache.get(k);
  const b = await client.getBlock({ blockNumber });
  const ts = Number(b.timestamp);
  blockTsCache.set(k, ts);
  return ts;
}

const txFromCache = new Map(); // txHash->from
async function getTxFrom(hash) {
  const k = hash.toLowerCase();
  if (txFromCache.has(k)) return txFromCache.get(k);
  const tx = await client.getTransaction({ hash });
  const from = tx.from ? tx.from.toLowerCase() : null;
  txFromCache.set(k, from);
  return from;
}

async function saveTradeToDatabase({
  token,
  isBuy,
  usd,
  tokenAmt,
  price,
  wallet,
  hash,
  logIndex,
  blockNumber,
  chainId,
  createdAtIso,
}) {
  const { error } = await supabase.from("trades").insert({
    token_address: token.toLowerCase(),
    is_buy: isBuy,
    usd_amount: usd,
    token_amount: tokenAmt,
    price,
    wallet_address: wallet.toLowerCase(),
    tx_hash: hash.toLowerCase(),
    log_index: logIndex ?? null,
    block_number: blockNumber ? Number(blockNumber) : null,
    chain_id: chainId ?? null,
    created_at: createdAtIso ?? null,
  });

  // only safe to ignore duplicates if you added UNIQUE index as recommended
  if (error && error.code !== "23505") console.error("❌ Supabase trades:", error.message);
  else if (!error) console.log(`✅ [${isBuy ? "BUY " : "SELL"}] ${token.slice(0, 6)}... $${usd.toFixed(2)}`);
}

async function saveSwapToDatabase({
  txHash,
  userAddress,
  amountIn,
  amountOut,
  tokenIn,
  tokenOut,
  pairAddress,
  chainId,
  blockNumber,
  timestampIso,
}) {
  const { error } = await supabase.from("swaps").upsert(
    {
      tx_hash: txHash.toLowerCase(),
      user_address: (userAddress || "0x0000000000000000000000000000000000000000").toLowerCase(),
      amount_in: amountIn.toString(),
      amount_out: amountOut.toString(),
      token_in: tokenIn.toLowerCase(),
      token_out: tokenOut.toLowerCase(),
      pair_address: pairAddress.toLowerCase(),
      chain_id: chainId ?? null,
      block_number: blockNumber ? Number(blockNumber) : null,
      timestamp: timestampIso ?? new Date().toISOString(),
    },
    { onConflict: "tx_hash,chain_id" }
  );

  if (error && error.code !== "23505") console.error("❌ Supabase swaps:", error.message);
  else if (!error) console.log(`✅ [SWAP] ${txHash.slice(0, 10)}... pair=${pairAddress.slice(0, 6)}...`);
}

// pairAddress(lower)->{token0,token1}
const pairMeta = new Map();
async function ensurePairMeta(pairAddress) {
  const p = pairAddress.toLowerCase();
  const existing = pairMeta.get(p);
  if (existing) return existing;

  const [t0, t1] = await Promise.all([
    client.readContract({
      address: getAddress(pairAddress),
      abi: pairTokenAbi,
      functionName: "token0",
    }),
    client.readContract({
      address: getAddress(pairAddress),
      abi: pairTokenAbi,
      functionName: "token1",
    }),
  ]);

  const meta = { token0: String(t0).toLowerCase(), token1: String(t1).toLowerCase() };
  pairMeta.set(p, meta);
  return meta;
}

// ---------- BACKFILL launchpad logs (so initial dev buy won't be missed) ----------
async function backfillLaunchpad() {
  const chainId = await client.getChainId();
  const latest = await client.getBlockNumber();
  const backfillBlocks = Number.isFinite(BACKFILL_BLOCKS) && BACKFILL_BLOCKS > 0 ? BACKFILL_BLOCKS : 0;

  if (backfillBlocks <= 0) {
    console.log("ℹ️ BACKFILL_BLOCKS=0, skip backfill");
    return;
  }

  const from = latest > BigInt(backfillBlocks) ? latest - BigInt(backfillBlocks) : 0n;
  const to = latest;

  console.log(`⏮️ Backfill launchpad logs: fromBlock=${from} toBlock=${to} (range=${backfillBlocks})`);

  for (let start = from; start <= to; start += BigInt(BACKFILL_CHUNK)) {
    const end = start + BigInt(BACKFILL_CHUNK) - 1n <= to ? start + BigInt(BACKFILL_CHUNK) - 1n : to;

    try {
      const [buyLogs, sellLogs] = await Promise.all([
        client.getLogs({ address: launchpadAddr, event: buyEvent, fromBlock: start, toBlock: end }),
        client.getLogs({ address: launchpadAddr, event: sellEvent, fromBlock: start, toBlock: end }),
      ]);

      const all = [...buyLogs.map((l) => ({ kind: "BUY", l })), ...sellLogs.map((l) => ({ kind: "SELL", l }))];
      // stable ordering
      all.sort((a, b) => {
        const ab = a.l.blockNumber ?? 0n;
        const bb = b.l.blockNumber ?? 0n;
        if (ab !== bb) return ab < bb ? -1 : 1;
        const ai = a.l.logIndex ?? 0n;
        const bi = b.l.logIndex ?? 0n;
        return ai < bi ? -1 : ai > bi ? 1 : 0;
      });

      for (const it of all) {
        const log = it.l;
        const ts = await getBlockTimestamp(log.blockNumber);
        const createdAtIso = ts ? new Date(ts * 1000).toISOString() : new Date().toISOString();

        if (it.kind === "BUY") {
          const usdAmt = Number(log.args.amountInUsd) / 1e6;
          const tokenAmt = Number(log.args.amountOutToken) / 1e6;
          const price = tokenAmt > 0 ? usdAmt / tokenAmt : 0;
          await saveTradeToDatabase({
            token: log.args.token,
            isBuy: true,
            usd: usdAmt,
            tokenAmt,
            price,
            wallet: log.args.buyer,
            hash: log.transactionHash,
            logIndex: log.logIndex != null ? Number(log.logIndex) : null,
            blockNumber: log.blockNumber,
            chainId,
            createdAtIso,
          });
        } else {
          const usdAmt = Number(log.args.amountOutUsd) / 1e6;
          const tokenAmt = Number(log.args.amountInToken) / 1e6;
          const price = tokenAmt > 0 ? usdAmt / tokenAmt : 0;
          await saveTradeToDatabase({
            token: log.args.token,
            isBuy: false,
            usd: usdAmt,
            tokenAmt,
            price,
            wallet: log.args.seller,
            hash: log.transactionHash,
            logIndex: log.logIndex != null ? Number(log.logIndex) : null,
            blockNumber: log.blockNumber,
            chainId,
            createdAtIso,
          });
        }
      }
    } catch (e) {
      console.error(`❌ Backfill chunk failed [${start}-${end}]`, e);
    }
  }

  console.log("✅ Backfill done");
}

// ---------- watchers ----------
async function watchLaunchpad() {
  const chainId = await client.getChainId();

  client.watchEvent({
    address: launchpadAddr,
    event: buyEvent,
    onLogs: async (logs) => {
      for (const log of logs) {
        try {
          const ts = await getBlockTimestamp(log.blockNumber);
          const createdAtIso = ts ? new Date(ts * 1000).toISOString() : new Date().toISOString();

          const usdAmt = Number(log.args.amountInUsd) / 1e6;
          const tokenAmt = Number(log.args.amountOutToken) / 1e6;
          const price = tokenAmt > 0 ? usdAmt / tokenAmt : 0;

          await saveTradeToDatabase({
            token: log.args.token,
            isBuy: true,
            usd: usdAmt,
            tokenAmt,
            price,
            wallet: log.args.buyer,
            hash: log.transactionHash,
            logIndex: log.logIndex != null ? Number(log.logIndex) : null,
            blockNumber: log.blockNumber,
            chainId,
            createdAtIso,
          });
        } catch (e) {
          console.error("❌ buy log failed:", e);
        }
      }
    },
  });

  client.watchEvent({
    address: launchpadAddr,
    event: sellEvent,
    onLogs: async (logs) => {
      for (const log of logs) {
        try {
          const ts = await getBlockTimestamp(log.blockNumber);
          const createdAtIso = ts ? new Date(ts * 1000).toISOString() : new Date().toISOString();

          const usdAmt = Number(log.args.amountOutUsd) / 1e6;
          const tokenAmt = Number(log.args.amountInToken) / 1e6;
          const price = tokenAmt > 0 ? usdAmt / tokenAmt : 0;

          await saveTradeToDatabase({
            token: log.args.token,
            isBuy: false,
            usd: usdAmt,
            tokenAmt,
            price,
            wallet: log.args.seller,
            hash: log.transactionHash,
            logIndex: log.logIndex != null ? Number(log.logIndex) : null,
            blockNumber: log.blockNumber,
            chainId,
            createdAtIso,
          });
        } catch (e) {
          console.error("❌ sell log failed:", e);
        }
      }
    },
  });
}

async function watchDexFromRouterAndFactoryPolling() {
  const chainId = await client.getChainId();

  const factory = await client.readContract({
    address: routerAddr,
    abi: routerReadAbi,
    functionName: "factory",
  });
  const factoryAddr = getAddress(String(factory));
  console.log("🏭 Router.factory():", factoryAddr);

  const watchedPairs = new Set();

  async function watchPair(pairAddress) {
    const pair = getAddress(pairAddress);
    const key = pair.toLowerCase();
    if (watchedPairs.has(key)) return;
    watchedPairs.add(key);

    await ensurePairMeta(pair);

    client.watchEvent({
      address: pair,
      event: pairSwapEvent,
      onLogs: async (logs) => {
        const lastByTx = new Map();
        for (const l of logs) {
          const k = l.transactionHash.toLowerCase();
          const prev = lastByTx.get(k);
          if (!prev || (l.logIndex ?? 0n) > (prev.logIndex ?? 0n)) lastByTx.set(k, l);
        }

        for (const log of lastByTx.values()) {
          try {
            const sender = String(log.args.sender || "").toLowerCase();
            if (sender !== routerAddr.toLowerCase()) continue;

            const meta = await ensurePairMeta(pair);

            const a0In = BigInt(log.args.amount0In);
            const a1In = BigInt(log.args.amount1In);
            const a0Out = BigInt(log.args.amount0Out);
            const a1Out = BigInt(log.args.amount1Out);

            let tokenIn, tokenOut, amountIn, amountOut;
            if (a0In > 0n) {
              tokenIn = meta.token0;
              tokenOut = meta.token1;
              amountIn = a0In;
              amountOut = a1Out;
            } else if (a1In > 0n) {
              tokenIn = meta.token1;
              tokenOut = meta.token0;
              amountIn = a1In;
              amountOut = a0Out;
            } else {
              continue;
            }

            const ts = await getBlockTimestamp(log.blockNumber);
            const timestampIso = ts ? new Date(ts * 1000).toISOString() : new Date().toISOString();

            const userAddress = await getTxFrom(log.transactionHash);

            await saveSwapToDatabase({
              txHash: log.transactionHash,
              userAddress,
              amountIn,
              amountOut,
              tokenIn,
              tokenOut,
              pairAddress: pair,
              chainId,
              blockNumber: log.blockNumber,
              timestampIso,
            });
          } catch (e) {
            console.error("❌ swap failed:", e);
          }
        }
      },
    });

    console.log("👀 Watching pair:", pair);
  }

  async function seedPairsOnce() {
    const len = await client.readContract({
      address: factoryAddr,
      abi: factoryReadAbi,
      functionName: "allPairsLength",
    });
    const n = Number(len);
    console.log("📦 Factory pairs:", n);

    for (let i = 0; i < n; i++) {
      const pair = await client.readContract({
        address: factoryAddr,
        abi: factoryReadAbi,
        functionName: "allPairs",
        args: [BigInt(i)],
      });
      const addr = String(pair);
      if (isAddress(addr)) await watchPair(addr);
    }
  }

  await seedPairsOnce();

  setInterval(async () => {
    try {
      const len = await client.readContract({
        address: factoryAddr,
        abi: factoryReadAbi,
        functionName: "allPairsLength",
      });
      const n = Number(len);

      for (let i = Math.max(0, n - 50); i < n; i++) {
        const pair = await client.readContract({
          address: factoryAddr,
          abi: factoryReadAbi,
          functionName: "allPairs",
          args: [BigInt(i)],
        });
        const addr = String(pair);
        if (isAddress(addr)) await watchPair(addr);
      }
    } catch (e) {
      console.error("❌ factory polling error:", e);
    }
  }, 30_000);
}

async function main() {
  console.log("=========================================");
  console.log("🚀 DEXTEMPO INDEXER RUNNING");
  console.log("📡 RPC:", RPC_URL);
  console.log("🏗️ Launchpad:", launchpadAddr);
  console.log("🧭 Router:", routerAddr);
  console.log("=========================================");

  // ✅ IMPORTANT: backfill first, then realtime watch
  await backfillLaunchpad();
  await watchLaunchpad();
  await watchDexFromRouterAndFactoryPolling();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
