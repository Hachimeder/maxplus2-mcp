# Third-party software and test data

The MIT license covers this repository's code, documentation and self-authored
examples. MAX+plus II is separate proprietary software; its installer, executable
images, device libraries and license files are not included. Install and license
it separately. Product names belong to their respective owners; this project is
not affiliated with or endorsed by the product vendor.

The Windows desktop backend is source code in `native/MaxplusDesktop.cs` and builds
locally using the installed .NET Framework. No vendor DLL or prebuilt desktop
helper is distributed.

The Windows-936 conversion table enumerates character-code mappings using the
Windows decoder. Numerical GDF transform vectors are observations of format
behavior, not executable images or decompiled vendor source. SCF fixtures are
small outputs of a self-authored XOR design and contain only anonymous signals
A, B and Q. The pagination drawing is generated from custom symbols in the tests.

Tests requiring vendor symbols read the user's installed library at runtime;
those library files are not copied into this repository.
