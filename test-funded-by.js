/**
 * 测试 funded-by 和 source_balance_zero 逻辑
 *
 * 使用方法：
 *   node test-funded-by.js <钱包地址>
 *
 * 示例：
 *   node test-funded-by.js 2P5FgpkjmxYnpmun5EcxMvmotMA95tUCHf6AxUUMQe7c
 */

import { getWalletFundedBy, getWalletBalance, getWalletIdentity } from './src/utils/api.js';

async function testWallet(walletAddress) {
    console.log(`\n🔍 测试地址：${walletAddress}`);
    console.log('='.repeat(60));

    // Step 1: 获取资金来源
    console.log('\n📌 Step 1: 获取资金来源 (funded-by)...');
    const fundedBy = await getWalletFundedBy(walletAddress);

    if (!fundedBy?.funder) {
        console.log('❌ 未找到资金来源');
        console.log('\n📊 判定结果：✅ 条件 1 成立 (无资金来源) → 庄家');
        return {
            hasSource: false,
            balanceZero: false,
            finalResult: '庄家 (无资金来源)'
        };
    }

    const funder = fundedBy.funder;
    console.log(`   [资助者]: ${funder}`);
    console.log(`   [资助金额]: ${fundedBy.amount} ${fundedBy.symbol || 'SOL'}`);
    console.log(`   [资助时间]: ${fundedBy.date}`);
    console.log(`   [交易签名]: ${fundedBy.signature ? fundedBy.signature.slice(0, 40) + '...' : 'null'}`);

    // Step 2: 检查资助者身份（可选）
    console.log('\n📌 Step 2: 检查资助者身份...');
    const identity = await getWalletIdentity(funder);
    const isExchange = identity?.name !== null && identity?.name !== undefined && identity.name !== '';
    const identityName = identity?.name || identity?.type || 'unknown';

    console.log(`   [资助者名称]: ${identityName}`);
    console.log(`   [是否交易所]: ${isExchange ? '❌ 是' : '✅ 否'}`);

    if (isExchange) {
        console.log('\n📊 判定结果：❌ FALSE (资金来源于交易所) → 散户');
        return {
            hasSource: true,
            balanceZero: false,
            finalResult: '散户 (交易所来源)'
        };
    }

    // Step 3: 检查来源账户余额
    console.log('\n📌 Step 3: 检查来源账户 SOL 余额...');
    const balance = await getWalletBalance(funder);

    if (balance === null) {
        console.log('❌ 余额查询失败');
        return {
            hasSource: true,
            balanceZero: false,
            finalResult: '查询失败'
        };
    }

    console.log(`   [余额]: ${balance} SOL`);

    const isZero = balance === 0;
    console.log(`   [是否为 0]: ${isZero ? '✅ 是' : '❌ 否'}`);

    // Step 4: 汇总判定
    console.log('\n' + '='.repeat(60));

    let finalResult;
    if (isZero) {
        console.log('📊 判定结果：✅ 条件 3 成立 (来源账户余额为 0) → 庄家');
        finalResult = '庄家 (余额为 0)';
    } else {
        console.log('📊 判定结果：❌ 条件不成立 (余额不为 0) → 散户');
        finalResult = '散户 (余额不为 0)';
    }

    console.log('='.repeat(60));

    return {
        hasSource: true,
        balanceZero: isZero,
        funder,
        finalResult
    };
}

// 运行
const addr = process.argv[2];
if (!addr) {
    console.log('使用方法：node test-funded-by.js <Wallet_Address>');
    console.log('示例：node test-funded-by.js 2P5FgpkjmxYnpmun5EcxMvmotMA95tUCHf6AxUUMQe7c');
    process.exit(1);
}

testWallet(addr)
    .then(result => {
        console.log('\n结果摘要:', JSON.stringify(result, null, 2));
        process.exit(0);
    })
    .catch(err => {
        console.error('\n💥 程序执行出错:', err.message);
        console.error(err.stack);
        process.exit(1);
    });
