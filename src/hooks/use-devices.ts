'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadDevicePrefs, pickDevice, saveDevicePrefs, supportsSinkId, toOptions, type DeviceOption, type DevicePrefs } from '@/lib/devices';

/**
 * Microfones e saídas de áudio disponíveis e a escolha do usuário (salva no navegador).
 * A escolha "desejada" fica guardada à parte da efetiva: se o fone sumir, o app cai no padrão do sistema e
 * volta para o fone quando ele reaparecer.
 */
export function useDevices() {
  const [inputs, setInputs] = useState<DeviceOption[]>([]);
  const [outputs, setOutputs] = useState<DeviceOption[]>([]);
  const [micId, setMic] = useState('');
  const [outputId, setOutput] = useState('');
  const [canChooseOutput, setCanChooseOutput] = useState(false);
  const wanted = useRef<DevicePrefs>({ micId: null, outputId: null });
  const alive = useRef(true);
  const lists = useRef<{ inputs: DeviceOption[]; outputs: DeviceOption[] }>({ inputs: [], outputs: [] });

  const refresh = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      if (!alive.current) return;
      const ins = toOptions(list, 'audioinput');
      const outs = toOptions(list, 'audiooutput');
      lists.current = { inputs: ins, outputs: outs };
      setInputs(ins);
      setOutputs(outs);
      setMic(pickDevice(ins, wanted.current.micId, wanted.current.micLabel));
      setOutput(pickDevice(outs, wanted.current.outputId, wanted.current.outputLabel));
    } catch {
      /* sem acesso à lista: os seletores ficam vazios e o app usa o dispositivo padrão */
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    wanted.current = loadDevicePrefs();
    setCanChooseOutput(supportsSinkId());
    void refresh();
    const md = navigator.mediaDevices;
    md?.addEventListener?.('devicechange', refresh);
    return () => {
      alive.current = false;
      md?.removeEventListener?.('devicechange', refresh);
    };
  }, [refresh]);

  const setMicId = useCallback((id: string) => {
    const opt = lists.current.inputs.find((o) => o.id === id);
    // rótulo gerado por nós ("Microfone 2") não identifica o aparelho: não vale como reserva
    wanted.current = { ...wanted.current, micId: id, micLabel: opt && !opt.generic ? opt.label : undefined };
    saveDevicePrefs(wanted.current);
    setMic(id);
  }, []);

  const setOutputId = useCallback((id: string) => {
    const opt = lists.current.outputs.find((o) => o.id === id);
    wanted.current = { ...wanted.current, outputId: id, outputLabel: opt && !opt.generic ? opt.label : undefined };
    saveDevicePrefs(wanted.current);
    setOutput(id);
  }, []);

  return { inputs, outputs, micId, outputId, setMicId, setOutputId, canChooseOutput, refresh };
}
