// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Minimal ERC-20 for local tests only.
contract Token {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s, uint8 d) { name = n; symbol = s; decimals = d; }

    function mint(address to, uint256 v) external { totalSupply += v; balanceOf[to] += v; emit Transfer(address(0), to, v); }

    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v; balanceOf[to] += v; emit Transfer(msg.sender, to, v); return true;
    }

    function approve(address sp, uint256 v) external returns (bool) { allowance[msg.sender][sp] = v; emit Approval(msg.sender, sp, v); return true; }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[to] += v; emit Transfer(f, to, v); return true;
    }
}
