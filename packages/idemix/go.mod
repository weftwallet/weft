module github.com/ifeanyi-ugwu/weft/packages/idemix

go 1.26.3

toolchain go1.26.10

require (
	github.com/IBM/idemix v0.3.1
	github.com/IBM/mathlib v0.3.2
	github.com/hyperledger/fabric-protos-go-apiv2 v0.3.7
	google.golang.org/protobuf v1.36.11
)

require (
	github.com/bits-and-blooms/bitset v1.24.6 // indirect
	github.com/consensys/gnark-crypto v0.21.0 // indirect
	github.com/hyperledger/fabric-amcl v0.0.0-20230602173724-9e02669dceb2 // indirect
	github.com/ifeanyi-ugwu/weft/examples/private-ballot-contract v0.0.0-00010101000000-000000000000
	go.uber.org/multierr v1.11.0 // indirect
	go.uber.org/zap v1.28.0 // indirect
	golang.org/x/crypto v0.57.0 // indirect
	golang.org/x/sys v0.48.0 // indirect
)

replace github.com/ifeanyi-ugwu/weft/examples/private-ballot-contract => ../../examples/private-ballot-contract
