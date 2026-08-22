const urlStr = "https://eth-sepolia.g.alchemy.com/v2/alch_d7S3t4hyopu2nVcbaMwre";
try {
  new URL(urlStr);
  console.log("Success");
} catch(e) {
  console.log("Error:", e.message);
}
