'use client';

import { useState, useEffect } from 'react';
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  formatEther,
  formatUnits,
  parseUnits,
  parseEther,
  decodeEventLog
} from 'viem';

// ============ UPDATE THIS WITH YOUR CONTRACT ADDRESS ============
const GAME_ADDRESS = '0x5E779AC2c0E1Fd2D686fc7b8cdb2fc4D86239978';
// ================================================================

const somniaTestnet = {
  id: 50312,
  name: 'Somnia Testnet',
  nativeCurrency: { name: 'STT', symbol: 'STT', decimals: 18 },
  rpcUrls: {
    default: {
      http: ['https://dream-rpc.somnia.network/'],
      webSocket: ['wss://dream-rpc.somnia.network/ws']
    }
  },
  blockExplorers: {
    default: { name: 'Somnia Explorer', url: 'https://shannon-explorer.somnia.network' }
  }
};

const gameAbi = [
  { type: 'function', name: 'owner', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'TOTAL_FEE', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getPrizePool', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getSupportedCryptos', inputs: [], outputs: [{ type: 'string[]' }], stateMutability: 'view' },
  {
    type: 'function', name: 'getPlayerStats', inputs: [{ name: 'player', type: 'address' }],
    outputs: [{
      type: 'tuple',
      components: [
        { name: 'totalGuesses', type: 'uint256' },
        { name: 'wins', type: 'uint256' },
        { name: 'totalWinnings', type: 'uint256' },
        { name: 'bestAccuracyBps', type: 'uint256' }
      ]
    }],
    stateMutability: 'view'
  },
  {
    type: 'function', name: 'getCooldownRemaining', inputs: [{ name: 'player', type: 'address' }],
    outputs: [{ type: 'uint256' }], stateMutability: 'view'
  },
  {
    type: 'function', name: 'getPendingGuess', inputs: [{ name: 'requestId', type: 'uint256' }],
    outputs: [{
      type: 'tuple',
      components: [
        { name: 'player', type: 'address' },
        { name: 'crypto', type: 'string' },
        { name: 'guessedPrice', type: 'uint256' },
        { name: 'timestamp', type: 'uint256' },
        { name: 'resolved', type: 'bool' }
      ]
    }],
    stateMutability: 'view'
  },
  { type: 'function', name: 'fundPool', inputs: [], outputs: [], stateMutability: 'payable' },
  {
    type: 'function', name: 'guess',
    inputs: [{ name: 'crypto', type: 'string' }, { name: 'predictedPrice', type: 'uint256' }],
    outputs: [{ name: 'requestId', type: 'uint256' }],
    stateMutability: 'payable'
  },
  {
    type: 'function', name: 'testGuess',
    inputs: [{ name: 'crypto', type: 'string' }, { name: 'predictedPrice', type: 'uint256' }],
    outputs: [{ name: 'requestId', type: 'uint256' }],
    stateMutability: 'payable'
  },
  {
    type: 'event', name: 'GuessMade',
    inputs: [
      { name: 'requestId', type: 'uint256', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'crypto', type: 'string', indexed: false },
      { name: 'guessedPrice', type: 'uint256', indexed: false }
    ]
  },
  {
    type: 'event', name: 'GuessResolved',
    inputs: [
      { name: 'requestId', type: 'uint256', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'crypto', type: 'string', indexed: false },
      { name: 'guessedPrice', type: 'uint256', indexed: false },
      { name: 'actualPrice', type: 'uint256', indexed: false },
      { name: 'accuracyBps', type: 'uint256', indexed: false },
      { name: 'reward', type: 'uint256', indexed: false },
      { name: 'won', type: 'bool', indexed: false }
    ]
  }
] as const;

const CRYPTO_OPTIONS = [
  { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', icon: '₿', gradient: 'from-orange-500 to-yellow-500' },
  { id: 'ethereum', symbol: 'ETH', name: 'Ethereum', icon: 'Ξ', gradient: 'from-blue-500 to-purple-500' },
  { id: 'solana', symbol: 'SOL', name: 'Solana', icon: '◎', gradient: 'from-purple-500 to-pink-500' },
];

interface PlayerStats {
  totalGuesses: bigint;
  wins: bigint;
  totalWinnings: bigint;
  bestAccuracyBps: bigint;
}

interface GameResult {
  guessedPrice: string;
  actualPrice: string;
  accuracyBps: number;
  reward: string;
  won: boolean;
  tier: string;
  txHash: string;
}

export default function PredictionGame() {
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [prizePool, setPrizePool] = useState<string>('0');
  const [totalFee, setTotalFee] = useState<bigint>(BigInt(0));
  const [supportedCryptos, setSupportedCryptos] = useState<string[]>([]);
  const [playerStats, setPlayerStats] = useState<PlayerStats | null>(null);
  const [cooldownRemaining, setCooldownRemaining] = useState<number>(0);
  const [selectedCrypto, setSelectedCrypto] = useState(CRYPTO_OPTIONS[0]);
  const [guessedPrice, setGuessedPrice] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [gameResult, setGameResult] = useState<GameResult | null>(null);
  const [fundAmount, setFundAmount] = useState<string>('1');
  const [showFundModal, setShowFundModal] = useState(false);

  const publicClient = createPublicClient({ chain: somniaTestnet, transport: http() });

  const loadContractData = async () => {
    try {
      const [pool, fee, cryptos, owner] = await Promise.all([
        publicClient.readContract({ address: GAME_ADDRESS, abi: gameAbi, functionName: 'getPrizePool' }),
        publicClient.readContract({ address: GAME_ADDRESS, abi: gameAbi, functionName: 'TOTAL_FEE' }),
        publicClient.readContract({ address: GAME_ADDRESS, abi: gameAbi, functionName: 'getSupportedCryptos' }),
        publicClient.readContract({ address: GAME_ADDRESS, abi: gameAbi, functionName: 'owner' }),
      ]);

      setPrizePool(formatEther(pool as bigint));
      setTotalFee(fee as bigint);
      setSupportedCryptos(cryptos as string[]);

      if (account) {
        setIsOwner((owner as string).toLowerCase() === account.toLowerCase());
        const [stats, cooldown] = await Promise.all([
          publicClient.readContract({ address: GAME_ADDRESS, abi: gameAbi, functionName: 'getPlayerStats', args: [account as `0x${string}`] }),
          publicClient.readContract({ address: GAME_ADDRESS, abi: gameAbi, functionName: 'getCooldownRemaining', args: [account as `0x${string}`] }),
        ]);
        setPlayerStats(stats as PlayerStats);
        setCooldownRemaining(Number(cooldown));
      }
    } catch (error) {
      console.error('Error loading contract data:', error);
    }
  };

  useEffect(() => {
    loadContractData();
    const interval = setInterval(loadContractData, 10000);
    return () => clearInterval(interval);
  }, [account]);

  useEffect(() => {
    if (cooldownRemaining > 0) {
      const timer = setInterval(() => setCooldownRemaining(prev => Math.max(0, prev - 1)), 1000);
      return () => clearInterval(timer);
    }
  }, [cooldownRemaining]);

  const connectWallet = async () => {
    if (typeof window.ethereum === 'undefined') { alert('Please install MetaMask!'); return; }
    try {
      const walletClient = createWalletClient({ chain: somniaTestnet, transport: custom(window.ethereum!) });
      const [address] = await walletClient.requestAddresses();
      setAccount(address);
      const currentChainId = await window.ethereum.request({ method: 'eth_chainId' }) as string;
      const chainIdNum = parseInt(currentChainId, 16);
      setChainId(chainIdNum);
      if (chainIdNum !== somniaTestnet.id) {
        try {
          await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${somniaTestnet.id.toString(16)}` }] });
          setChainId(somniaTestnet.id);
        } catch (switchError: any) {
          if (switchError.code === 4902) {
            await window.ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [{ chainId: `0x${somniaTestnet.id.toString(16)}`, chainName: somniaTestnet.name, nativeCurrency: somniaTestnet.nativeCurrency, rpcUrls: [somniaTestnet.rpcUrls.default.http[0]], blockExplorerUrls: [somniaTestnet.blockExplorers.default.url] }],
            });
            setChainId(somniaTestnet.id);
          }
        }
      }
    } catch (error) { console.error('Failed to connect:', error); }
  };

  const submitGuess = async (useTestGuess: boolean = false) => {
    if (!account || !guessedPrice) return;
    setLoading(true); setStatus('Preparing transaction...'); setGameResult(null); setTxHash(null);

    try {
      const walletClient = createWalletClient({ chain: somniaTestnet, transport: custom(window.ethereum!) });
      const priceWithDecimals = parseUnits(guessedPrice, 8);
      setStatus('Please confirm in wallet...');

      const functionName = useTestGuess ? 'testGuess' : 'guess';
      const hash = await walletClient.writeContract({
        address: GAME_ADDRESS, abi: gameAbi, functionName, args: [selectedCrypto.id, priceWithDecimals],
        value: totalFee, account: account as `0x${string}`, chain: somniaTestnet,
      });

      setTxHash(hash);
      setStatus('Transaction sent! Waiting for confirmation...');
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      let requestId: bigint | null = null;
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({ abi: gameAbi, data: log.data, topics: log.topics });
          if (decoded.eventName === 'GuessMade') { requestId = (decoded.args as any).requestId; break; }
        } catch { }
      }

      if (!requestId) { setStatus('Error: Could not find request ID'); setLoading(false); return; }
      setStatus(`✓ Guess submitted! Waiting for Somnia Agent...`);

      const startTime = Date.now();
      while (Date.now() - startTime < 120000) {
        const pendingGuess = await publicClient.readContract({ address: GAME_ADDRESS, abi: gameAbi, functionName: 'getPendingGuess', args: [requestId] }) as any;
        if (pendingGuess.resolved) {
          const logs = await publicClient.getLogs({
            address: GAME_ADDRESS,
            event: { type: 'event', name: 'GuessResolved', inputs: [
              { name: 'requestId', type: 'uint256', indexed: true }, { name: 'player', type: 'address', indexed: true },
              { name: 'crypto', type: 'string', indexed: false }, { name: 'guessedPrice', type: 'uint256', indexed: false },
              { name: 'actualPrice', type: 'uint256', indexed: false }, { name: 'accuracyBps', type: 'uint256', indexed: false },
              { name: 'reward', type: 'uint256', indexed: false }, { name: 'won', type: 'bool', indexed: false }
            ]},
            args: { requestId }, fromBlock: receipt.blockNumber, toBlock: 'latest'
          });
          if (logs.length > 0) {
            const args = logs[0].args as any;
            const accuracyBps = Number(args.accuracyBps);
            let tier: string;
            if (accuracyBps <= 10) tier = '🏆 Tier 1 (≤0.1%) - 10x';
            else if (accuracyBps <= 50) tier = '🥇 Tier 2 (≤0.5%) - 5x';
            else if (accuracyBps <= 100) tier = '🥈 Tier 3 (≤1.0%) - 3x';
            else if (accuracyBps <= 200) tier = '🥉 Tier 4 (≤2.0%) - 2x';
            else if (accuracyBps <= 500) tier = '✓ Tier 5 (≤5.0%) - 1x';
            else tier = '❌ No win (>5.0%)';
            setGameResult({ guessedPrice: formatUnits(args.guessedPrice, 8), actualPrice: formatUnits(args.actualPrice, 8), accuracyBps, reward: formatEther(args.reward), won: args.won, tier, txHash: logs[0].transactionHash });
            setStatus(args.won ? '🎉 You won!' : 'Better luck next time!');
            await loadContractData();
          }
          setLoading(false); return;
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
        setStatus(`Waiting for Somnia Agent... (${Math.floor((Date.now() - startTime) / 1000)}s)`);
      }
      setStatus('Timeout - check explorer for result');
    } catch (error: any) {
      console.error('Error:', error);
      setStatus(`Error: ${error.message || 'Transaction failed'}`);
    } finally { setLoading(false); }
  };

  const fundPool = async () => {
    if (!account || !fundAmount) return;
    setLoading(true); setStatus('Funding prize pool...');
    try {
      const walletClient = createWalletClient({ chain: somniaTestnet, transport: custom(window.ethereum!) });
      const hash = await walletClient.writeContract({ address: GAME_ADDRESS, abi: gameAbi, functionName: 'fundPool', value: parseEther(fundAmount), account: account as `0x${string}`, chain: somniaTestnet });
      setStatus('Waiting for confirmation...');
      await publicClient.waitForTransactionReceipt({ hash });
      setStatus('Pool funded!'); setShowFundModal(false); await loadContractData();
    } catch (error: any) { setStatus(`Error: ${error.message}`); } finally { setLoading(false); }
  };

  const formatCooldown = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-900 to-gray-900 text-white">
      {/* Header */}
      <header className="border-b border-purple-500/20 bg-black/20 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-4 py-4 flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">🎯 Price Prediction Game</h1>
            <p className="text-sm text-gray-400">Powered by Somnia Agents</p>
          </div>
          {!account ? (
            <button onClick={connectWallet} className="px-6 py-2 bg-gradient-to-r from-purple-600 to-pink-600 rounded-lg font-semibold hover:opacity-90 transition">Connect Wallet</button>
          ) : (
            <div className="flex items-center gap-4">
              {isOwner && <span className="px-3 py-1 bg-yellow-500/20 text-yellow-400 rounded-full text-sm">⭐ Owner</span>}
              <div className="text-right">
                <div className="font-mono text-sm">{account.slice(0, 6)}...{account.slice(-4)}</div>
                <div className={`text-xs ${chainId === somniaTestnet.id ? 'text-green-400' : 'text-red-400'}`}>{chainId === somniaTestnet.id ? '● Somnia' : '● Wrong Network'}</div>
              </div>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Prize Pool */}
        <div className="mb-8 p-6 bg-gradient-to-r from-purple-600/20 to-pink-600/20 border border-purple-500/30 rounded-2xl text-center">
          <p className="text-sm text-purple-300 mb-1">💎 Prize Pool</p>
          <p className="text-4xl font-bold">{parseFloat(prizePool).toFixed(4)} STT</p>
          {isOwner && <button onClick={() => setShowFundModal(true)} className="mt-3 px-4 py-1 bg-purple-600/50 rounded-lg text-sm hover:bg-purple-600/70 transition">+ Fund Pool</button>}
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {/* Game Panel */}
          <div className="md:col-span-2 space-y-6">
            {/* Crypto Selection */}
            <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-6">
              <h2 className="text-lg font-semibold mb-4">Select Cryptocurrency</h2>
              <div className="grid grid-cols-3 gap-3">
                {CRYPTO_OPTIONS.filter(c => supportedCryptos.includes(c.id)).map((crypto) => (
                  <button key={crypto.id} onClick={() => setSelectedCrypto(crypto)}
                    className={`p-4 rounded-xl border-2 transition ${selectedCrypto.id === crypto.id ? `border-purple-500 bg-gradient-to-br ${crypto.gradient} bg-opacity-20` : 'border-gray-600 bg-gray-700/30 hover:border-gray-500'}`}>
                    <div className="text-3xl mb-2">{crypto.icon}</div>
                    <div className="font-bold">{crypto.symbol}</div>
                    <div className="text-xs text-gray-400">{crypto.name}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Price Input */}
            <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-6">
              <h2 className="text-lg font-semibold mb-4">Your Prediction for {selectedCrypto.symbol}</h2>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-2xl text-gray-400">$</span>
                <input type="number" value={guessedPrice} onChange={(e) => setGuessedPrice(e.target.value)} placeholder="Enter price..."
                  className="w-full bg-gray-900 border border-gray-600 rounded-xl px-12 py-4 text-2xl font-bold focus:border-purple-500 focus:outline-none" />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400">USD</span>
              </div>
              <div className="mt-4 flex justify-between text-sm text-gray-400">
                <span>Entry: 0.01 STT</span><span>Agent: 0.1 STT</span><span className="text-white font-semibold">Total: {formatEther(totalFee)} STT</span>
              </div>

              {/* Buttons */}
              <div className="mt-6 space-y-3">
                <button onClick={() => submitGuess(false)} disabled={loading || !account || !guessedPrice || cooldownRemaining > 0 || chainId !== somniaTestnet.id}
                  className="w-full py-4 bg-gradient-to-r from-purple-600 to-pink-600 rounded-xl font-bold text-lg transition disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90">
                  {loading ? <span className="flex items-center justify-center gap-2"><svg className="animate-spin h-5 w-5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>Processing...</span>
                    : cooldownRemaining > 0 ? `⏳ Cooldown: ${formatCooldown(cooldownRemaining)}` : `🎯 Submit Guess (${formatEther(totalFee)} STT)`}
                </button>
                {isOwner && (
                  <button onClick={() => submitGuess(true)} disabled={loading || !account || !guessedPrice || chainId !== somniaTestnet.id}
                    className="w-full py-3 bg-yellow-600/30 border border-yellow-500/50 rounded-xl font-semibold text-yellow-400 transition disabled:opacity-50 disabled:cursor-not-allowed hover:bg-yellow-600/40">
                    ⭐ Owner Test (No Cooldown)
                  </button>
                )}
              </div>

              {status && <div className="mt-4 p-3 bg-gray-900/50 border border-gray-700 rounded-lg text-sm flex items-center gap-2">
                {loading && <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>}
                {status}
              </div>}
              {txHash && <div className="mt-2 text-center"><a href={`https://shannon-explorer.somnia.network/tx/${txHash}`} target="_blank" className="text-purple-400 text-sm hover:underline">View Transaction →</a></div>}
            </div>

            {/* Result */}
            {gameResult && (
              <div className={`p-6 rounded-xl border-2 ${gameResult.won ? 'bg-green-900/20 border-green-500/50' : 'bg-red-900/20 border-red-500/50'}`}>
                <h3 className="text-xl font-bold mb-4">{gameResult.won ? '🎉 You Won!' : '😔 Better Luck Next Time'}</h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div className="bg-black/20 p-3 rounded-lg"><p className="text-gray-400">Your Guess</p><p className="text-xl font-bold">${parseFloat(gameResult.guessedPrice).toLocaleString()}</p></div>
                  <div className="bg-black/20 p-3 rounded-lg"><p className="text-gray-400">Actual Price</p><p className="text-xl font-bold">${parseFloat(gameResult.actualPrice).toLocaleString()}</p></div>
                  <div className="bg-black/20 p-3 rounded-lg"><p className="text-gray-400">Accuracy</p><p className="text-xl font-bold">{(gameResult.accuracyBps / 100).toFixed(2)}% off</p></div>
                  <div className="bg-black/20 p-3 rounded-lg"><p className="text-gray-400">Reward</p><p className={`text-xl font-bold ${gameResult.won ? 'text-green-400' : 'text-gray-400'}`}>{gameResult.won ? `+${gameResult.reward} STT` : '0 STT'}</p></div>
                </div>
                <div className="mt-4 p-3 bg-black/30 rounded-lg text-center"><p className="font-semibold text-lg">{gameResult.tier}</p></div>
                <a href={`https://shannon-explorer.somnia.network/tx/${gameResult.txHash}`} target="_blank" className="block mt-3 text-purple-400 text-sm hover:underline text-center">View on Explorer →</a>
              </div>
            )}
          </div>

          {/* Stats Panel */}
          <div className="space-y-6">
            {/* Tiers */}
            <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-6">
              <h2 className="text-lg font-semibold mb-4">🏆 Reward Tiers</h2>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between p-2 bg-yellow-500/10 rounded-lg"><span>🏆 ≤0.1%</span><span className="font-bold">10x</span></div>
                <div className="flex justify-between p-2 bg-gray-500/10 rounded-lg"><span>🥇 ≤0.5%</span><span className="font-bold">5x</span></div>
                <div className="flex justify-between p-2 bg-orange-500/10 rounded-lg"><span>🥈 ≤1.0%</span><span className="font-bold">3x</span></div>
                <div className="flex justify-between p-2 bg-orange-700/10 rounded-lg"><span>🥉 ≤2.0%</span><span className="font-bold">2x</span></div>
                <div className="flex justify-between p-2 bg-gray-700/30 rounded-lg"><span>✓ ≤5.0%</span><span className="font-bold">1x</span></div>
                <div className="flex justify-between p-2 bg-red-500/10 rounded-lg text-red-400"><span>❌ &gt;5%</span><span>Loss</span></div>
              </div>
            </div>

            {/* Player Stats */}
            {account && playerStats && (
              <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-6">
                <h2 className="text-lg font-semibold mb-4">📊 Your Stats</h2>
                <div className="space-y-3">
                  <div className="flex justify-between"><span className="text-gray-400">Total Guesses</span><span className="font-bold">{playerStats.totalGuesses.toString()}</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">Wins</span><span className="font-bold text-green-400">{playerStats.wins.toString()}</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">Win Rate</span><span className="font-bold">{playerStats.totalGuesses > 0 ? ((Number(playerStats.wins) / Number(playerStats.totalGuesses)) * 100).toFixed(1) + '%' : 'N/A'}</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">Total Winnings</span><span className="font-bold text-green-400">{parseFloat(formatEther(playerStats.totalWinnings)).toFixed(4)} STT</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">Best Accuracy</span><span className="font-bold">{playerStats.bestAccuracyBps > 0 ? (Number(playerStats.bestAccuracyBps) / 100).toFixed(2) + '%' : 'N/A'}</span></div>
                </div>
              </div>
            )}

            {/* How to Play */}
            <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-6">
              <h2 className="text-lg font-semibold mb-4">📖 How to Play</h2>
              <ol className="space-y-2 text-sm text-gray-300 list-decimal list-inside">
                <li>Connect your wallet</li>
                <li>Select a cryptocurrency</li>
                <li>Enter your price prediction</li>
                <li>Submit (0.11 STT total)</li>
                <li>Wait for actual price</li>
                <li>Win based on accuracy!</li>
              </ol>
              <div className="mt-4 p-3 bg-purple-900/30 rounded-lg text-xs text-purple-300">
                💡 Check <a href="https://www.coingecko.com" target="_blank" className="underline">CoinGecko</a> for live prices!
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Fund Modal */}
      {showFundModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 max-w-md w-full">
            <h3 className="text-xl font-bold mb-4">💰 Fund Prize Pool</h3>
            <input type="number" value={fundAmount} onChange={(e) => setFundAmount(e.target.value)} className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-3 text-lg mb-4" placeholder="Amount in STT" />
            <div className="flex gap-3">
              <button onClick={() => setShowFundModal(false)} className="flex-1 py-3 bg-gray-700 rounded-lg hover:bg-gray-600 transition font-semibold">Cancel</button>
              <button onClick={fundPool} disabled={loading} className="flex-1 py-3 bg-gradient-to-r from-purple-600 to-pink-600 rounded-lg hover:opacity-90 transition font-semibold disabled:opacity-50">{loading ? 'Funding...' : 'Fund'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="border-t border-gray-800 mt-12 py-6 text-center text-sm text-gray-500">
        <p>Built with Somnia Agents • On-chain Reactivity</p>
        <div className="mt-2 space-x-4">
          <a href="https://somnia.network" target="_blank" className="text-purple-400 hover:underline">Somnia</a>
          <a href={`https://shannon-explorer.somnia.network/address/${GAME_ADDRESS}`} target="_blank" className="text-purple-400 hover:underline">Contract</a>
          <a href="https://somnia.network/faucet" target="_blank" className="text-purple-400 hover:underline">Faucet</a>
        </div>
      </footer>
    </div>
  );
}