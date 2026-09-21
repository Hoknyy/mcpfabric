package dev.mcpfabric.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.List;

/** Typed, null-safe accessor over the {@code params} object of an RPC call. */
public final class RpcContext {
	private final String method;
	private final JsonObject params;

	public RpcContext(String method, JsonObject params) {
		this.method = method;
		this.params = params == null ? new JsonObject() : params;
	}

	public String method() {
		return method;
	}

	public JsonObject params() {
		return params;
	}

	public boolean has(String key) {
		return params.has(key) && !params.get(key).isJsonNull();
	}

	// --- required ----------------------------------------------------------------------------

	public String getString(String key) throws RpcException {
		require(key);
		if (!params.get(key).isJsonPrimitive() || !params.get(key).getAsJsonPrimitive().isString()) throw new IllegalArgumentException(key + " must be a string.");
		return params.get(key).getAsString();
	}

	public int getInt(String key) throws RpcException {
		require(key);
		return integer(key).intValueExact();
	}

	public double getDouble(String key) throws RpcException {
		require(key);
		double value = number(key).doubleValue();
		if (!Double.isFinite(value)) throw new IllegalArgumentException(key + " must be finite.");
		return value;
	}

	public JsonObject getObject(String key) throws RpcException {
		require(key);
		if (!params.get(key).isJsonObject()) throw RpcException.badRequest("Param '" + key + "' must be an object.");
		return params.getAsJsonObject(key);
	}

	// --- optional ----------------------------------------------------------------------------

	public String optString(String key, String def) {
		if (!has(key)) return def;
		if (!params.get(key).isJsonPrimitive() || !params.get(key).getAsJsonPrimitive().isString()) throw new IllegalArgumentException(key + " must be a string.");
		return params.get(key).getAsString();
	}

	public int optInt(String key, int def) {
		return has(key) ? integer(key).intValueExact() : def;
	}

	public long optLong(String key, long def) {
		return has(key) ? integer(key).longValueExact() : def;
	}

	public double optDouble(String key, double def) {
		double value = has(key) ? number(key).doubleValue() : def;
		if (!Double.isFinite(value)) throw new IllegalArgumentException(key + " must be finite.");
		return value;
	}

	public boolean optBool(String key, boolean def) {
		return has(key) ? bool(key) : def;
	}

	public Boolean optBoolean(String key) {
		return has(key) ? bool(key) : null;
	}

	public JsonObject optObject(String key) {
		return has(key) && params.get(key).isJsonObject() ? params.getAsJsonObject(key) : null;
	}

	public List<String> getStringList(String key) {
		List<String> out = new ArrayList<>();
		if (has(key) && params.get(key).isJsonArray()) {
			JsonArray a = params.getAsJsonArray(key);
			for (JsonElement e : a) {
				if (!e.isJsonNull()) out.add(e.getAsString());
			}
		}
		return out;
	}

	private java.math.BigDecimal number(String key) {
		if (!params.get(key).isJsonPrimitive() || !params.get(key).getAsJsonPrimitive().isNumber()) throw new IllegalArgumentException(key + " must be a number.");
		return params.get(key).getAsBigDecimal();
	}
	private java.math.BigInteger integer(String key) { return number(key).toBigIntegerExact(); }
	private boolean bool(String key) {
		if (!params.get(key).isJsonPrimitive() || !params.get(key).getAsJsonPrimitive().isBoolean()) throw new IllegalArgumentException(key + " must be boolean.");
		return params.get(key).getAsBoolean();
	}
	private void require(String key) throws RpcException {
		if (!has(key)) throw RpcException.badRequest("Missing required param '" + key + "'.");
	}
}
