import { catalog } from "@promptslim/model-config";
import { requestCost, getModel } from "@promptslim/pricing-engine";
console.log("models:", catalog.models.length, "cost:", requestCost(getModel("gpt-5.4")!, 1000, 500).toFixed(6));
