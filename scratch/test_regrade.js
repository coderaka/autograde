async function main() {
  console.log("Triggering AI regrade via Local Server API for Submission 1 with gemini-3.5-flash...");
  const response = await fetch("http://localhost:3000/api/submissions/1/ai-grade", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gemini-3.5-flash" })
  });

  const data = await response.json();
  console.log("API Response Status:", response.status);
  console.log("API Response Body:", JSON.stringify(data, null, 2));
}

main().catch(console.error);
