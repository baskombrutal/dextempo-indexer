import * as dotenv from 'dotenv';
dotenv.config();

import { createPublicClient, http, parseAbiItem, formatUnits } from 'viem';
import { createClient } from '@supabase/supabase-js';

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL; 
const LAUNCHPAD_CA = process.env.NEXT_PUBLIC_TOKEN_FACTORY_LOCALHOST; 
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("❌ ERROR: File .env tidak terbaca!");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const client = createPublicClient({ transport: http(RPC_URL) });

const buyEvent = parseAbiItem('event TokensBought(address indexed token, address indexed buyer, uint256 amountInUsd, uint256 amountOutToken)');
const sellEvent = parseAbiItem('event TokensSold(address indexed token, address indexed seller, uint256 amountInToken, uint256 amountOutUsd)');

async function watchEvents() {
    console.log("=========================================");
    console.log("🚀 INDEXER DEXTEMPO RUNNING!");
    console.log(`📡 RPC: ${RPC_URL}`);
    console.log("=========================================");

    client.watchEvent({
        address: LAUNCHPAD_CA, event: buyEvent,
        onLogs: async (logs) => {
            for (const log of logs) {
                const usdAmt = Number(formatUnits(log.args.amountInUsd, 6));
                const tokenAmt = Number(formatUnits(log.args.amountOutToken, 6));
                const price = usdAmt / tokenAmt; 
                await saveToDatabase(log.args.token, true, usdAmt, tokenAmt, price, log.args.buyer, log.transactionHash);
            }
        }
    });

    client.watchEvent({
        address: LAUNCHPAD_CA, event: sellEvent,
        onLogs: async (logs) => {
            for (const log of logs) {
                const usdAmt = Number(formatUnits(log.args.amountOutUsd, 6));
                const tokenAmt = Number(formatUnits(log.args.amountInToken, 6));
                const price = usdAmt / tokenAmt; 
                await saveToDatabase(log.args.token, false, usdAmt, tokenAmt, price, log.args.seller, log.transactionHash);
            }
        }
    });
}

async function saveToDatabase(token, isBuy, usd, tokenAmt, price, wallet, hash) {
    try {
        const { error } = await supabase.from('trades').insert({
            token_address: token.toLowerCase(), is_buy: isBuy, usd_amount: usd,
            token_amount: tokenAmt, price: price, wallet_address: wallet, tx_hash: hash
        });
        
        if (error && error.code !== '23505') console.error("❌ Supabase Error:", error.message);
        else if (!error) console.log(`✅ [${isBuy ? 'BUY ' : 'SELL'}] Token: ${token.slice(0,6)}... | USD: $${usd.toFixed(2)}`);
    } catch (err) { console.error("Gagal nyimpan:", err); }
}

watchEvents();