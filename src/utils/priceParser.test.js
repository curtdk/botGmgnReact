
const { parsePriceText } = require('./priceParser');

// 测试用例
const testCases = [
    { input: '$0.0₄245', expected: 0.0000245 }, // 用户提供的案例
    { input: '$0.0000245', expected: 0.0000245 },
    { input: '0.0₄245', expected: 0.0000245 },
    { input: '$123.45', expected: 123.45 },
    { input: '$0.0₅123', expected: 0.00000123 }, // 5个0
    { input: '$0.00₄245', expected: 0.000000245 }, // 0.00 + 4 zeros + 245 -> 0.00 0000 245
    { input: null, expected: null },
    { input: '', expected: null },
];

console.log('Running Price Parser Tests...\n');

let passed = 0;
let failed = 0;

testCases.forEach((test, index) => {
    const result = parsePriceText(test.input);
    const isSuccess = Math.abs(result - test.expected) < 0.000000001 || (result === test.expected);
    
    if (isSuccess) {
        console.log(`✅ Test ${index + 1} Passed: Input "${test.input}" -> ${result}`);
        passed++;
    } else {
        console.error(`❌ Test ${index + 1} Failed: Input "${test.input}"`);
        console.error(`   Expected: ${test.expected}`);
        console.error(`   Got:      ${result}`);
        failed++;
    }
});

console.log(`\nTests Completed: ${passed} Passed, ${failed} Failed`);

if (failed > 0) {
    process.exit(1);
}
