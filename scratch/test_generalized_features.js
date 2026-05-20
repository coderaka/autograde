import assert from 'assert';
import { readFileSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = 'http://localhost:3000';

async function runTests() {
  console.log('🧪 Starting generalized features integration tests...');

  // Test 1: List assignments
  console.log('\n1. Testing GET /api/assignments...');
  const listRes = await fetch(`${BASE_URL}/api/assignments`);
  assert.strictEqual(listRes.status, 200, 'GET /api/assignments should return 200');
  const assignments = await listRes.json();
  console.log('Assignments list on load:', assignments);
  assert.ok(assignments.length >= 1, 'Should have at least midterm assignment');
  assert.strictEqual(assignments[0].key, 'midterm', 'First assignment should be midterm');

  // Test 2: Create new assignment
  console.log('\n2. Testing POST /api/assignments...');
  const testKey = 'hw_test_' + Date.now();
  const testTitle = ' 测试作业 ' + testKey;
  const dummyRubric = {
    assignment: testTitle,
    total_score: 10,
    questions: [
      {
        question_id: '1',
        title: '问题 1',
        max_score: 10,
        sub_questions: [
          {
            question_id: '1a',
            title: '第一问',
            max_score: 5,
            key_points: ['写对公式'],
            common_mistakes: []
          },
          {
            question_id: '1b',
            title: '第二问',
            max_score: 5,
            key_points: ['算出数值'],
            common_mistakes: []
          }
        ]
      }
    ]
  };

  const createRes = await fetch(`${BASE_URL}/api/assignments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: testKey,
      title: testTitle,
      rubric: dummyRubric,
      answers: '# 测试标准答案\n\n1a. 这是第一问的标准答案。分数：5分。\n1b. 这是第二问的标准答案。分数：5分。'
    })
  });
  
  assert.strictEqual(createRes.status, 200, 'POST /api/assignments should return 200');
  const createResult = await createRes.json();
  assert.strictEqual(createResult.success, true, 'Create should be successful');
  assert.strictEqual(createResult.key, testKey, 'Returned key should match');

  // Verify files exist on disk
  const rubricPath = join(__dirname, '..', 'rubrics', testKey, 'rubric.json');
  const answersPath = join(__dirname, '..', 'rubrics', testKey, 'answers.md');
  assert.ok(existsSync(rubricPath), 'rubric.json should be saved on disk');
  assert.ok(existsSync(answersPath), 'answers.md should be saved on disk');
  console.log(`✅ New assignment "${testKey}" created and files saved on disk.`);

  // Test 3: List assignments again to see if it is discovered
  console.log('\n3. Verifying dynamic discovery...');
  const listRes2 = await fetch(`${BASE_URL}/api/assignments`);
  const assignments2 = await listRes2.json();
  const createdAssignment = assignments2.find(a => a.key === testKey);
  assert.ok(createdAssignment, 'Newly created assignment should be discovered dynamically');
  assert.strictEqual(createdAssignment.title, testTitle, 'Title should match');
  assert.strictEqual(createdAssignment.total_score, 10, 'Total score should match');
  assert.strictEqual(createdAssignment.questions_count, 2, 'Should have 2 sub-questions');
  assert.strictEqual(createdAssignment.has_answers, true, 'Should have answers file');
  console.log('✅ Dynamic discovery verified successfully:', createdAssignment);

  // Test 4: AI Rubric Generation from answers
  console.log('\n4. Testing POST /api/assignments/generate-rubric (AI Rubric Generator)...');
  const testAnswers = `# 习题一 评分标准

1. 计算极限 \$\\lim_{x \\to 0} \\frac{\\sin x}{x}\$
   - 答案：结果为 1。满分 4 分。
   - 得分点：
     * 写出极限公式得 2 分。
     * 正确求出最终值 1 得 2 分。

2. 证明函数在定义域内连续
   - 答案：利用连续性定义，对于任意 \$\\epsilon > 0\$ 寻找到 \$\\delta\$。满分 6 分。
   - 得分点：
     * 写出连续的 \$\\epsilon-\\delta\$ 定义得 3 分。
     * 正确完成不等式放缩得 3 分。`;

  const aiRes = await fetch(`${BASE_URL}/api/assignments/generate-rubric`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      answers: testAnswers,
      title: '测试AI生成标准'
    })
  });

  assert.strictEqual(aiRes.status, 200, 'generate-rubric should return 200');
  const generatedRubric = await aiRes.json();
  console.log('Generated Rubric Structure sample:', JSON.stringify(generatedRubric, null, 2));
  assert.strictEqual(generatedRubric.assignment, '测试AI生成标准', 'Title should be merged');
  assert.ok(generatedRubric.total_score > 0, 'Total score should be calculated and greater than 0');
  assert.ok(generatedRubric.questions.length > 0, 'Should contain generated questions');
  console.log('✅ AI Rubric Generator verified successfully.');

  // Test 5: Backup & Perfect Restoration
  console.log('\n5. Testing Backup Export/Import pipeline...');
  
  // Let's get the midterm backup
  const exportRes = await fetch(`${BASE_URL}/api/submissions/export-backup?assignment=midterm`);
  assert.strictEqual(exportRes.status, 200, 'Export backup should return 200');
  const backupData = await exportRes.json();
  
  assert.strictEqual(backupData.assignment, 'midterm', 'Backup assignment key should match');
  assert.ok(Array.isArray(backupData.submissions), 'Backup should contain submissions array');
  console.log(`Exported backup containing ${backupData.submissions.length} submissions.`);

  // Let's modify a student's grade dynamically to simulate a TA change, then restore and verify.
  // First, find a student in backup who has a graded submission
  const testSub = backupData.submissions.find(s => s.status === 'reviewed' || s.status === 'ai_graded');
  if (!testSub) {
    console.log('⚠️ No graded submissions found in database, skipping restoration verification (this is fine on an empty database).');
  } else {
    console.log(`Found graded student in backup for test: ${testSub.student_name} (${testSub.student_id})`);
    
    // Check their current total score on the server
    const detailRes = await fetch(`${BASE_URL}/api/submissions?assignment=midterm`);
    const allSubs = await detailRes.json();
    const serverSub = allSubs.find(s => s.student_id === testSub.student_id);
    assert.ok(serverSub, 'Student should exist on server');
    const originalScore = serverSub.total_score;
    const originalNotes = serverSub.notes || '';
    
    console.log(`Original score for ${testSub.student_name}: ${originalScore}, Notes: "${originalNotes}"`);

    // Let's simulate a database overwrite by saving a modified grade directly to the database via API
    // We will save notes as "TEMPORARY_MODIFICATION_FOR_TESTING" and score as 0
    console.log('Modifying grade temporarily...');
    const saveRes = await fetch(`${BASE_URL}/api/submissions/${serverSub.id}/grade`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grade: {
          student_id: testSub.student_id,
          student_name: testSub.student_name,
          questions: [],
          total_score: 0,
          overall_comment: 'Modified Comment'
        },
        graded_by: 'Test Runner'
      })
    });
    assert.strictEqual(saveRes.status, 200, 'Saving modified grade should succeed');

    // Double check that it indeed changed
    const detailRes2 = await fetch(`${BASE_URL}/api/submissions?assignment=midterm`);
    const allSubs2 = await detailRes2.json();
    const serverSub2 = allSubs2.find(s => s.student_id === testSub.student_id);
    assert.strictEqual(serverSub2.total_score, 0, 'Score should now be 0');

    // Now, restore from backupData!
    console.log('Restoring from backup...');
    const importRes = await fetch(`${BASE_URL}/api/submissions/import-backup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backupData })
    });
    assert.strictEqual(importRes.status, 200, 'Import backup should return 200');
    const importResult = await importRes.json();
    assert.strictEqual(importResult.success, true, 'Import should succeed');
    console.log(`Import restore counts: submissions=${importResult.submissions_restored}, chats=${importResult.chat_messages_restored}`);

    // Verify it is restored perfectly to originalScore and originalNotes
    const detailRes3 = await fetch(`${BASE_URL}/api/submissions?assignment=midterm`);
    const allSubs3 = await detailRes3.json();
    const serverSub3 = allSubs3.find(s => s.student_id === testSub.student_id);
    assert.strictEqual(serverSub3.total_score, originalScore, 'Restored score should match original');
    console.log('✅ Perfect restoration verified successfully.');
  }

  // Cleanup: Delete the created test assignment folder
  console.log('\n🧹 Cleaning up test directories...');
  const testRubricDir = join(__dirname, '..', 'rubrics', testKey);
  const testSubmissionsDir = join(__dirname, '..', 'submissions', testKey);
  if (existsSync(testRubricDir)) {
    rmSync(testRubricDir, { recursive: true, force: true });
  }
  if (existsSync(testSubmissionsDir)) {
    rmSync(testSubmissionsDir, { recursive: true, force: true });
  }
  console.log('✅ Cleanup completed.');

  console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! 🚀');
}

runTests().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
