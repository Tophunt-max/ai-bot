import { router } from "expo-router";
import { useState } from "react";
import { Text, TextInput } from "react-native";
import { Button, Card, ErrorText, Muted, Screen, colors, s } from "../../src/components/ui";
import { api } from "../../src/lib/api";
import { useAuth } from "../../src/stores/auth";

/** Personal use: single owner account, no public registration. */
export default function Login() {
  const signIn = useAuth((st) => st.signIn);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { token } = await api.login(email.trim(), password);
      await signIn(token);
      router.replace("/(tabs)/dashboard");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="AI Trading Bot">
      <Muted>Owner login. Trading involves risk; nothing here guarantees profit.</Muted>
      <Card>
        <Text style={{ color: colors.muted }}>Email</Text>
        <TextInput
          style={s.input}
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
          placeholder="owner@example.com"
          placeholderTextColor={colors.muted}
        />
        <Text style={{ color: colors.muted }}>Password</Text>
        <TextInput
          style={s.input}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
          placeholderTextColor={colors.muted}
        />
        {error ? <ErrorText error={error} /> : null}
        <Button
          label={busy ? "Signing in…" : "Sign in"}
          onPress={submit}
          disabled={busy || !email || !password}
        />
      </Card>
    </Screen>
  );
}
